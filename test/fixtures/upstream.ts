import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Upstream {
  readonly url: string;
  readonly received: Received[];
  close(): Promise<void>;
}

/** A local upstream that records each request and answers 200 with `x-upstream: fake` and a JSON body naming the path. */
export function fakeUpstream(): Promise<Upstream> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json", "x-upstream": "fake" });
      response.end(JSON.stringify({ upstream: request.url }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}
