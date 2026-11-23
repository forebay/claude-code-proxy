import type { ServerResponse } from "node:http";
import type { Catalog, Snapshot } from "./catalog.js";
import { PROVIDER_HANDLE, REPLY, REPORT, STEP } from "./kinds.js";
import { Relay } from "./relay.js";
import type { Anthropic, Handle, Pair, ProviderHandleAnswer, Report, Routing, StepAnswer, StepArgument } from "./services.js";
import type { ProxySettings } from "./settings.js";
import { headersOf, writeJson } from "./wire.js";
import { zoneAt } from "./zone.js";

export interface Walker {
  readonly routing: Routing;
  readonly anthropic: Anthropic;
  readonly settings: ProxySettings;
  readonly catalog: Catalog;
  readonly writeLog: (lines: StepAnswer["log"]) => void;
  readonly passThrough: () => Promise<void>;
}

export interface Request {
  readonly ir?: Record<string, unknown>;
  readonly headers: readonly Pair[];
  readonly model: string | null;
  readonly passThrough: boolean;
}

interface Exchange {
  readonly walker: Walker;
  readonly request: Request;
  readonly response: ServerResponse;
  readonly relay: Relay;
  snapshot: Snapshot;
  refreshed: boolean;
  failureBody?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function argumentOf(exchange: Exchange, walk?: Handle, report?: Report): StepArgument {
  const { settings } = exchange.walker;
  return {
    providers: exchange.snapshot.names,
    profile: settings.profile,
    slots: exchange.snapshot.slots,
    catalog: exchange.snapshot.catalog,
    model: exchange.request.model,
    pass_through: exchange.request.passThrough ? 1 : 0,
    refreshed: exchange.refreshed ? 1 : 0,
    login_command: settings.loginCommand,
    settings_file: settings.settingsFile,
    ...(walk === undefined ? {} : { walk }),
    ...(report === undefined ? {} : { report }),
  };
}

async function stepped(exchange: Exchange, walk?: Handle, report?: Report): Promise<StepAnswer> {
  const answer = await exchange.walker.routing.step({ argument: argumentOf(exchange, walk, report) });
  exchange.walker.writeLog(answer.log);
  return answer;
}

async function handled(exchange: Exchange, answer: StepAnswer): Promise<ProviderHandleAnswer> {
  const provider = exchange.snapshot.byName.get(answer.provider ?? "");
  if (provider === undefined) throw new Error(`step named ${answer.provider}, which the proxy did not hand it`);
  try {
    return await provider.handle({ argument: { request: { ...exchange.request.ir, model: answer.model }, headers: exchange.request.headers } });
  } catch (error) {
    return { kind: PROVIDER_HANDLE.THROWN, message: messageOf(error) };
  }
}

/** Calls the provider step named and answers the report of how it went, or undefined once the client went away. */
async function called(exchange: Exchange, answer: StepAnswer): Promise<Report | undefined> {
  const served = await handled(exchange, answer);
  if (served.kind === PROVIDER_HANDLE.RESPONSE) {
    const body = await exchange.walker.anthropic.encode_response({ argument: { response: served.response } });
    writeJson(exchange.response, 200, body.bytes);
    return { kind: REPORT.RESPONSE };
  }
  if (served.kind === PROVIDER_HANDLE.FAILURE && served.failure !== undefined) {
    const { failure } = served;
    exchange.failureBody = failure.body ?? "";
    const retry = failure.has_retry_after === 1 ? { has_retry_after: 1, retry_after_milliseconds: failure.retry_after_milliseconds ?? 0 } : {};
    return { kind: REPORT.FAILURE, status: failure.status, headers: failure.headers ?? [], now: Date.now(), ...retry };
  }
  if (served.kind === PROVIDER_HANDLE.STREAM) {
    const provider = exchange.snapshot.byName.get(answer.provider ?? "");
    return provider === undefined ? undefined : exchange.relay.relayed(provider, served.stream);
  }
  return { kind: REPORT.THROWN, message: served.message ?? null };
}

async function rateLimited(exchange: Exchange, answer: StepAnswer): Promise<void> {
  const now = Date.now();
  const hasReset = answer.has_reset_at === 1;
  const reset = hasReset ? (answer.reset_at ?? now) : now;
  const argument = { upstream_headers: answer.headers ?? [], has_reset_at: hasReset ? 1 : 0, reset_at: hasReset ? reset : 0, now, ...zoneAt(reset) };
  const reply = await exchange.walker.anthropic.rate_limit_reply({ argument });
  exchange.response.writeHead(reply.status, headersOf(reply.headers));
  exchange.response.end(reply.body);
}

async function replied(exchange: Exchange, answer: StepAnswer): Promise<void> {
  const { response } = exchange;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (answer.reply_kind === REPLY.RATE_LIMITED) return rateLimited(exchange, answer);
  if (answer.reply_kind === REPLY.PROVIDER_FAILURE) {
    response.writeHead(answer.status ?? 502, headersOf(answer.headers));
    response.end(exchange.failureBody ?? "");
    return;
  }
  const body = await exchange.walker.anthropic.error_envelope({ argument: { reply_kind: answer.reply_kind ?? REPLY.PROXY_ERROR, message: answer.message ?? "" } });
  writeJson(response, answer.status ?? 500, body.bytes);
}

/** Performs one step; answers the report it owes `step`, or undefined when the walk ends here. */
async function performed(exchange: Exchange, answer: StepAnswer): Promise<Report | undefined> {
  switch (answer.kind) {
    case STEP.PASS_THROUGH:
      await exchange.walker.passThrough();
      return undefined;
    case STEP.CALL_PROVIDER:
      return called(exchange, answer);
    case STEP.REPLY:
      await replied(exchange, answer);
      return undefined;
    case STEP.END_STREAM:
      await exchange.relay.endWithError(answer.error_type, answer.message);
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Walks one request along the chain C answers, step by step, until C says it is done: every branch is C's, and this
 * holds only the calls, the I/O and their order.
 */
export async function walk(walker: Walker, request: Request, response: ServerResponse, signal: AbortSignal): Promise<void> {
  const exchange: Exchange = { walker, request, response, relay: new Relay(walker.anthropic, response, signal), snapshot: await walker.catalog.current(), refreshed: false };
  let answer = await stepped(exchange);
  try {
    while (answer.kind !== STEP.DONE && !signal.aborted) {
      if (answer.kind === STEP.REFRESH_MODELS) {
        exchange.snapshot = await walker.catalog.refresh();
        exchange.refreshed = true;
        answer.walk?.release();
        answer = await stepped(exchange);
        continue;
      }
      const report = await performed(exchange, answer);
      if (report === undefined || answer.walk === undefined) break;
      const previous = answer;
      answer = await stepped(exchange, previous.walk, report);
      previous.walk?.release();
    }
  } finally {
    answer.walk?.release();
    exchange.relay.release();
  }
}
