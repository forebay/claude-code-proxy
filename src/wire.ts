import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Pair } from "./services.js";

const JSON_TYPE = { "content-type": "application/json" };

/** The body did not fit under the limit C set; the rest of it is still unread. */
export class BodyTooLarge extends Error {}

export function pairsOf(headers: IncomingHttpHeaders): Pair[] {
  return Object.entries(headers).flatMap(([name, value]) => (value === undefined ? [] : [{ name, value: Array.isArray(value) ? value.join(", ") : value }]));
}

export function headersOf(pairs: readonly Pair[] | undefined): Record<string, string> {
  return Object.fromEntries((pairs ?? []).map((pair) => [pair.name, pair.value]));
}

/** The whole body, refused with BodyTooLarge as soon as it is known to pass `maxBytes`. */
export function bodyOf(incoming: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(incoming.headers["content-length"] ?? 0) > maxBytes) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const keep = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > maxBytes) {
        incoming.off("data", keep);
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    incoming.on("data", keep);
    incoming.on("error", reject);
    incoming.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export function writeJson(response: ServerResponse, status: number, body: Uint8Array | string | undefined): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, JSON_TYPE);
  response.end(body ?? "");
}

/** @implNote The rest of the body is read and dropped first, since closing over unread data resets the connection and loses the reply. */
export function drainedUnread(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader("connection", "close");
  if (incoming.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    incoming.once("end", () => resolve());
    incoming.once("error", () => resolve());
    incoming.resume();
  });
}

/** @implNote `close` on the response fires both when it finished and when the client went away; only the second aborts. */
export function disconnectSignal(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  return controller.signal;
}
