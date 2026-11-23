import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { FAILURE_REASON } from "./kinds.js";
import type { Anthropic, LogLine, Pair, Routing } from "./services.js";
import { headersOf, pairsOf, writeBody } from "./wire.js";

export interface PassThrough {
  readonly routing: Routing;
  readonly anthropic: Anthropic;
  readonly upstream: unknown;
  readonly placeholderAuthorization: unknown;
  readonly writeLog: (lines: readonly LogLine[]) => void;
}

type Sent = { readonly incoming: IncomingMessage } | { readonly error: Error };

function sent(target: string, method: string, headers: readonly Pair[], body: Buffer, signal: AbortSignal): Promise<Sent> {
  const url = new URL(target);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const outgoing = send(url, { method, headers: headersOf(headers), signal }, (incoming) => resolve({ incoming }));
    outgoing.on("error", (error) => resolve({ error }));
    outgoing.end(body);
  });
}

async function unreachable(through: PassThrough, response: ServerResponse, error: Error): Promise<void> {
  const failure = await through.routing.failure({ argument: { reason: FAILURE_REASON.UPSTREAM_UNREACHABLE, upstream: through.upstream, detail: error.message } });
  through.writeLog(failure.log);
  const body = await through.anthropic.error_envelope({ argument: { reply_kind: failure.reply_kind, message: failure.message } });
  writeBody(response, failure.status, body.headers, body.bytes);
}

/** Sends the request upstream undecoded, to the target and with the headers C answers, and its answer back as it came. */
export async function passThrough(through: PassThrough, request: IncomingMessage, body: Buffer, response: ServerResponse, signal: AbortSignal): Promise<void> {
  const argument = { upstream: through.upstream, url: request.url!, headers: pairsOf(request.headers), body_length: body.length, placeholder_authorization: through.placeholderAuthorization };
  const routed = await through.routing.pass_through({ argument });
  const answered = await sent(routed.target, request.method!, routed.headers, body, signal);
  if (signal.aborted) return;
  if ("error" in answered) {
    await unreachable(through, response, answered.error);
    return;
  }
  const upstream = answered.incoming;
  const replied = await through.routing.reply_headers({ argument: { headers: pairsOf(upstream.headers), rewritten: 0 } });
  response.writeHead(upstream.statusCode!, headersOf(replied.headers));
  await new Promise<void>((resolve) => {
    upstream.pipe(response);
    upstream.on("end", () => resolve());
    upstream.on("error", () => {
      response.destroy();
      resolve();
    });
  });
}
