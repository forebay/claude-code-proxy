import type { IncomingMessage, ServerResponse } from "node:http";
import type { Catalog } from "./catalog.js";
import { ARRIVAL, FAILURE_REASON, ROUTE } from "./kinds.js";
import { passThrough } from "./pass-through.js";
import type { Anthropic, Body, LimitsAnswer, LogLine, Routing } from "./services.js";
import type { ProxySettings } from "./settings.js";
import { walk, type Request } from "./walk.js";
import { BodyTooLarge, bodyOf, disconnectSignal, drainedUnread, pairsOf, writeBody } from "./wire.js";

export interface Proxy {
  readonly routing: Routing;
  readonly anthropic: Anthropic;
  readonly settings: ProxySettings;
  readonly port: number;
  readonly limits: LimitsAnswer;
  readonly catalog: Catalog;
  readonly writeLog: (lines: readonly LogLine[]) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function written(response: ServerResponse, body: Body): void {
  writeBody(response, body.status, body.headers, body.bytes);
}

/** An error reply: the status is the deciding answer's, the body and its headers `error_envelope`'s. */
async function envelope(proxy: Proxy, response: ServerResponse, status: number, replyKind: number, message: string): Promise<void> {
  const body = await proxy.anthropic.error_envelope({ argument: { reply_kind: replyKind, message } });
  writeBody(response, status, body.headers, body.bytes);
}

/** Answers what C's arrival decided, or false when the request is to be routed. */
async function answeredArrival(proxy: Proxy, incoming: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const arrival = await proxy.routing.arrival({ argument: { path: incoming.url!, headers: pairsOf(incoming.headers), port: proxy.port } });
  if (arrival.kind === ARRIVAL.HEALTH) {
    response.writeHead(arrival.status, { "content-type": arrival.content_type! });
    response.end(arrival.body!);
    return true;
  }
  if (arrival.kind === ARRIVAL.REFUSE) {
    await envelope(proxy, response, arrival.status, arrival.reply_kind, arrival.message!);
    return true;
  }
  return false;
}

async function models(proxy: Proxy, response: ServerResponse, lookup: string | undefined): Promise<void> {
  const snapshot = await proxy.catalog.current();
  const { entries } = await proxy.routing.model_entries({ argument: { profile: proxy.settings.profile, catalog: snapshot.catalog } });
  if (lookup === undefined) written(response, await proxy.anthropic.model_listing({ argument: { models: entries } }));
  else written(response, await proxy.anthropic.model_lookup({ argument: { models: entries, id: decodeURIComponent(lookup) } }));
}

/** The request as the walk takes it, or undefined once C's decode answered a reply of its own. */
async function decoded(proxy: Proxy, incoming: IncomingMessage, body: Buffer, response: ServerResponse): Promise<Request | undefined> {
  const answer = await proxy.anthropic.decode_request({ argument: { bytes: body, headers: pairsOf(incoming.headers) } });
  if (answer.request === undefined) {
    await envelope(proxy, response, answer.status, answer.reply_kind, answer.message!);
    return undefined;
  }
  return { ir: answer.request, headers: answer.forwarded_headers, model: answer.request.model, passThrough: false };
}

async function routed(proxy: Proxy, incoming: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
  const route = await proxy.anthropic.route_request({ argument: { method: incoming.method!, path: incoming.url! } });
  if (route.kind === ROUTE.MODEL_LIST || route.kind === ROUTE.MODEL_LOOKUP) {
    await models(proxy, response, route.kind === ROUTE.MODEL_LOOKUP ? route.model_id! : undefined);
    return;
  }
  const body = await bodyOf(incoming, proxy.limits.max_request_bytes);
  const request = route.kind === ROUTE.MESSAGES ? await decoded(proxy, incoming, body, response) : { headers: pairsOf(incoming.headers), model: null, passThrough: true };
  if (request === undefined) return;
  const { upstream, placeholderAuthorization } = proxy.settings;
  const through = { routing: proxy.routing, anthropic: proxy.anthropic, upstream, placeholderAuthorization, writeLog: proxy.writeLog };
  const walker = { routing: proxy.routing, anthropic: proxy.anthropic, settings: proxy.settings, catalog: proxy.catalog, writeLog: proxy.writeLog, passThrough: () => passThrough(through, incoming, body, response, signal) };
  await walk(walker, request, response, signal);
}

async function tooLarge(proxy: Proxy, incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  await drainedUnread(incoming, response);
  const { too_large_status, too_large_reply_kind, too_large_message } = proxy.limits;
  await envelope(proxy, response, too_large_status, too_large_reply_kind, too_large_message);
}

async function failed(proxy: Proxy, response: ServerResponse, error: unknown): Promise<void> {
  const failure = await proxy.routing.failure({ argument: { reason: FAILURE_REASON.REQUEST_FAILED, detail: messageOf(error) } });
  proxy.writeLog(failure.log);
  await envelope(proxy, response, failure.status, failure.reply_kind, failure.message);
}

/** Answers one request to the proxy, asking C at every turn: the arrival, the route, the decode and each step. */
export async function serve(proxy: Proxy, incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  const signal = disconnectSignal(response);
  try {
    if (await answeredArrival(proxy, incoming, response)) return;
    await routed(proxy, incoming, response, signal);
  } catch (error) {
    if (signal.aborted) return;
    const answered = error instanceof BodyTooLarge ? tooLarge(proxy, incoming, response) : failed(proxy, response, error);
    await answered.catch(() => response.destroy());
  }
}
