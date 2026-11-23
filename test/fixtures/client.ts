import { request } from "node:http";

export interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface Sent {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** One real HTTP request to the proxy on `port`, its whole answer read. */
export function sent(port: number, what: Sent): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, method: what.method ?? "POST", path: what.path, headers: { "content-type": "application/json", ...what.headers } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") }));
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(what.body);
  });
}

/** Sends `what` and goes away once the first bytes of the answer arrived, answering when it has. */
export function abandonedAfterFirstBytes(port: number, what: Sent): Promise<void> {
  return new Promise((resolve) => {
    const outgoing = request(
      { host: "127.0.0.1", port, method: what.method ?? "POST", path: what.path, headers: { "content-type": "application/json", ...what.headers } },
      (incoming) => incoming.once("data", () => outgoing.destroy()),
    );
    outgoing.on("error", () => undefined);
    outgoing.on("close", () => resolve());
    outgoing.end(what.body);
  });
}
