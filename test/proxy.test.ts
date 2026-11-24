import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, type RunningHost } from "@weivel/typescript/program";
import { freePort } from "@weivel/typescript/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { abandonedAfterFirstBytes, pending, sent, type Answer } from "./fixtures/client.js";
import { bundled, homeWith, HOST_ID, REPOSITORY, type Home, type Install } from "./fixtures/home.js";
import { fakeUpstream, type Upstream } from "./fixtures/upstream.js";

const MODEL = "claude-sonnet-4-5";
const MESSAGES = JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
const STREAMED_MESSAGES = JSON.stringify({ model: MODEL, max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] });
const RUN_BOUND = 60_000;

interface Logged {
  readonly level: string;
  readonly message: string;
}

interface Running {
  readonly home: Home;
  readonly host: RunningHost;
  readonly logged: Logged[];
}

let bundles: string;
let proxyBundle: string;
let providerBundle: string;
let upstream: Upstream;
const running: Running[] = [];
const blockers: Server[] = [];

function proxyInstall(port: number, settings: Record<string, unknown> = {}): Install {
  const manifest = JSON.parse(readFileSync(join(REPOSITORY, "plugin.json"), "utf8"));
  return { manifest, bundle: proxyBundle, settings: { proxy: { port }, upstream: upstream.url, ...settings } };
}

/** The user's stored model map, a chain of the two providers for the one model. */
function chainOfBoth(): Record<string, unknown> {
  const chain = [
    { provider: "alpha", model: MODEL },
    { provider: "beta", model: MODEL },
  ];
  return { routing: { modelMap: { sonnet: chain, default: chain } } };
}

/** Every line the loader's log holds, readable once the run stopped and its writer wrote them. */
function loggedIn(home: Home): string {
  const files = readdirSync(home.base, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".log"));
  return files.map((file) => readFileSync(join(home.base, file), "utf8")).join("\n");
}

/** The loader's ready record the run published: ready, or the refusal naming the plugin that did not start. */
function readyRecord(home: Home): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home.base, "state", "processes", `${HOST_ID}.ready.json`), "utf8"));
}

function waited(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listedIds(body: string): string[] {
  return JSON.parse(body).data.map((model: { id: string }) => model.id);
}

/** Answers once the proxy on `port` answers its health check. */
async function listening(port: number): Promise<void> {
  for (;;) {
    const answer = await sent(port, { method: "GET", path: "/health" }).catch(() => undefined);
    if (answer?.status === 200) return;
    await waited(20);
  }
}

/** What the test provider records of the calls made to it. */
interface CallProbe {
  readonly cancelled: number;
  readonly handledTokens: readonly bigint[];
  readonly cancelledTokens: readonly bigint[];
}

interface Change {
  readonly port: number;
  readonly sentBeforeTheChange: boolean;
  readonly first: Promise<Answer>;
  readonly second: Answer;
}

/**
 * Starts zeta at once and zulu 600 ms later unless its settings delay it otherwise, sends a first `/v1/models` while
 * only zeta is offered, and a second once zulu is, which changes the list.
 */
async function changedDuringARound(zeta: Record<string, unknown>, zulu: Record<string, unknown>): Promise<Change> {
  const port = await freePort();
  let activated = false;
  // Ids that sort after the proxy's: runtime activates in that order, so the proxy listens before they activate.
  const run = started([
    proxyInstall(port),
    providerInstall("zeta", "plain", zeta),
    providerInstall("zulu", "plain", { model: "claude-haiku-4-5", activateDelay: "600", ...zulu }),
  ]).then((running) => {
    activated = true;
    return running;
  });
  await listening(port);
  await waited(100);
  const sentBeforeTheChange = !activated;
  const first = sent(port, { method: "GET", path: "/v1/models" });
  await run;
  const second = await sent(port, { method: "GET", path: "/v1/models" });
  return { port, sentBeforeTheChange, first, second };
}

function providerInstall(id: string, mode: string, settings: Record<string, unknown> = {}): Install {
  const manifest = {
    api: 1,
    importName: id,
    id,
    version: "1.0.0",
    entry: "index.js",
    capabilities: { provides: ["forebay.provider"] },
    services: { consumes: ["weivel.config"], provides: [`${id}:probe`] },
    config: { defaults: {} },
  };
  return { manifest, bundle: providerBundle, settings: { mode, name: id, model: MODEL, ...settings } };
}

async function started(installs: readonly Install[]): Promise<Running> {
  const home = homeWith(installs);
  const logged: Logged[] = [];
  const log = {
    debug: (message: string) => logged.push({ level: "debug", message }),
    info: (message: string) => logged.push({ level: "info", message }),
    warn: (message: string) => logged.push({ level: "warn", message }),
    error: (message: string) => logged.push({ level: "error", message }),
  };
  const host = await startHost({ hostLibraryPath: home.runtime, arguments: [HOST_ID], log });
  const run = { home, host, logged };
  running.push(run);
  return run;
}

function blocked(port: number): Promise<void> {
  const server = createServer();
  blockers.push(server);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}

beforeAll(async () => {
  bundles = mkdtempSync(join(tmpdir(), "ccp-bundles-"));
  proxyBundle = await bundled(join(REPOSITORY, "src", "plugin.ts"), join(bundles, "proxy"));
  providerBundle = await bundled(join(REPOSITORY, "test", "fixtures", "provider", "index.ts"), join(bundles, "provider"));
}, RUN_BOUND);

beforeEach(async () => {
  upstream = await fakeUpstream();
});

afterAll(() => rmSync(bundles, { recursive: true, force: true }));

afterEach(async () => {
  for (const run of running.splice(0)) {
    try {
      await run.host.stop();
    } finally {
      run.home.remove();
    }
  }
  for (const server of blockers.splice(0)) await new Promise((closed) => server.close(() => closed(undefined)));
  await upstream.close();
});

describe("claude-code-proxy under the host program, over runtime in a temporary home", () => {
  it("answers a plain reply from the provider", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    const answer = await sent(port, { path: "/v1/messages", body: MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ type: "message", model: MODEL, content: [{ type: "text", text: "served by alpha" }] });
  }, RUN_BOUND);

  it("relays a streamed reply as Anthropic events", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "stream")]);

    const answer = await sent(port, { path: "/v1/messages", body: STREAMED_MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/event-stream");
    expect(answer.body).toContain("event: message_start");
    expect(answer.body).toContain("streamed by alpha");
    expect(answer.body).toContain("event: message_stop");
  }, RUN_BOUND);

  it("falls from a rate-limited first provider to the second", async () => {
    const port = await freePort();
    await started([proxyInstall(port, chainOfBoth()), providerInstall("alpha", "rate-limited"), providerInstall("beta", "plain")]);

    const answer = await sent(port, { path: "/v1/messages", body: MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ content: [{ type: "text", text: "served by beta" }] });
  }, RUN_BOUND);

  it("answers exhaustion with C's rate-limit reply, the reset named in the machine's zone", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const port = await freePort();
      await started([proxyInstall(port, chainOfBoth()), providerInstall("alpha", "rate-limited"), providerInstall("beta", "rate-limited")]);

      const answer = await sent(port, { path: "/v1/messages", body: MESSAGES });

      expect(answer.status, answer.body).toBe(429);
      expect(answer.headers["x-upstream"]).toBe("beta");
      expect(Number(answer.headers["retry-after"])).toBeGreaterThan(100);
      expect(JSON.parse(answer.body)).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
      expect(JSON.parse(answer.body).error.message).toMatch(/^You've hit your usage limit · resets at \d{1,2}:\d{2} (AM|PM) UTC$/);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  }, RUN_BOUND);

  it("passes a request no route serves through to the upstream, without the placeholder credential", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    const answer = await sent(port, { method: "POST", path: "/v1/messages/count_tokens?beta=true", headers: { authorization: "Bearer sk-ant-loader-proxy" }, body: MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(answer.headers["x-upstream"]).toBe("fake");
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]).toMatchObject({ method: "POST", url: "/v1/messages/count_tokens?beta=true", body: MESSAGES });
    expect(upstream.received[0]?.headers.authorization).toBeUndefined();
  }, RUN_BOUND);

  it.each([
    ["the whole placeholder", "Bearer sk-ant-loader-proxy"],
    ["the bare key", "sk-ant-loader-proxy"],
  ])("passes a request through without an x-api-key carrying %s", async (_form, key) => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    const answer = await sent(port, { method: "POST", path: "/v1/messages/count_tokens", headers: { "x-api-key": key }, body: MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]?.headers["x-api-key"]).toBeUndefined();
  }, RUN_BOUND);

  it("passes a request through with an x-api-key that is not the placeholder", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    await sent(port, { method: "POST", path: "/v1/messages/count_tokens", headers: { "x-api-key": "sk-ant-own-key" }, body: MESSAGES });

    expect(upstream.received[0]?.headers["x-api-key"]).toBe("sk-ant-own-key");
  }, RUN_BOUND);

  it("ends a stream that fails after bytes went out with an Anthropic error event", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "stream-fails"), providerInstall("beta", "plain")]);

    const answer = await sent(port, { path: "/v1/messages", body: STREAMED_MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(answer.body).toContain("partial");
    expect(answer.body).not.toContain("served by beta");
    expect(answer.body.trimEnd().split("\n\n").at(-1)).toMatch(/^event: error\ndata: .*"alpha broke mid stream"/s);
  }, RUN_BOUND);

  it("releases the provider's stream when the client goes away mid stream", async () => {
    const port = await freePort();
    const run = await started([proxyInstall(port), providerInstall("alpha", "hang")]);

    await abandonedAfterFirstBytes(port, { path: "/v1/messages", body: STREAMED_MESSAGES });

    const probe = (): { released: number; releasedWhileReading: number } | undefined => run.host.service("alpha", "alpha:probe");
    expect(probe()?.released).toBe(0);
    await expect.poll(() => probe()?.released, { timeout: 5_000 }).toBe(1);
    expect(probe()?.releasedWhileReading).toBe(0);
  }, RUN_BOUND);

  it("cancels the provider's pending call by its token when the client goes away", async () => {
    const port = await freePort();
    const run = await started([proxyInstall(port), providerInstall("alpha", "hang-handle")]);
    const probe = (): CallProbe | undefined => run.host.service("alpha", "alpha:probe");

    const request = pending(port, { path: "/v1/messages", body: MESSAGES });
    await expect.poll(() => probe()?.handledTokens.length, { timeout: 10_000 }).toBe(1);
    expect(probe()?.cancelled).toBe(0);
    await request.abandon();

    await expect.poll(() => probe()?.cancelled, { timeout: 5_000 }).toBe(1);
    expect(typeof probe()?.handledTokens[0]).toBe("bigint");
    expect(probe()?.cancelledTokens).toEqual(probe()?.handledTokens);
  }, RUN_BOUND);

  it("hands each call to a provider a token of its own", async () => {
    const port = await freePort();
    const run = await started([proxyInstall(port), providerInstall("alpha", "plain")]);
    const probe = (): CallProbe | undefined => run.host.service("alpha", "alpha:probe");

    await sent(port, { path: "/v1/messages", body: MESSAGES });
    await sent(port, { path: "/v1/messages", body: MESSAGES });

    const tokens = probe()?.handledTokens ?? [];
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(probe()?.cancelled).toBe(0);
  }, RUN_BOUND);

  it("names the loader's login command when no provider offers the model", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain", { emptyUntilAsk: "1000" })]);

    const answer = await sent(port, { path: "/v1/messages", body: MESSAGES });

    expect(answer.status, answer.body).toBe(503);
    expect(JSON.parse(answer.body).error.message).toContain("log a provider in with spisor-host action claude-code-loader alpha login");
  }, RUN_BOUND);

  it("logs an answer C refuses and keeps serving once that round's own timer closes it", async () => {
    const port = await freePort();
    const run = await started([proxyInstall(port), providerInstall("alpha", "models-refused")]);

    const listed = await sent(port, { method: "GET", path: "/v1/models" });
    const health = await sent(port, { method: "GET", path: "/health" });
    await run.host.stop();

    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({ data: [] });
    expect(health).toMatchObject({ status: 200, body: "ok" });
    expect(loggedIn(run.home)).toContain("holds a NUL, so it cannot cross into C whole");
  }, RUN_BOUND);

  it("makes a request arriving during an open round of the same providers wait for that round", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain", { emptyUntilAsk: "2", modelsDelay: "500" })]);

    const before = await sent(port, { method: "GET", path: "/v1/models" });
    await waited(3_100);
    const messages = sent(port, { path: "/v1/messages", body: MESSAGES });
    await waited(150);
    const during = await sent(port, { method: "GET", path: "/v1/models" });

    expect(listedIds(before.body)).toEqual([]);
    expect(listedIds(during.body)).toEqual([MODEL]);
    expect((await messages).status).toBe(200);
  }, RUN_BOUND);

  it("lets a change during an open round supersede it, whose waiters then wait for the new round", async () => {
    const change = await changedDuringARound({ firstAskDelay: "2500", modelsDelay: "1700" }, { modelsDelay: "1800" });

    expect(change.sentBeforeTheChange).toBe(true);
    expect(listedIds(change.second.body)).toEqual([MODEL, "claude-haiku-4-5"]);
    expect(listedIds((await change.first).body)).toEqual([MODEL, "claude-haiku-4-5"]);
  }, RUN_BOUND);

  it("keeps the newer round's models when the superseded round's answer for the same provider lands later", async () => {
    const change = await changedDuringARound({ firstAskDelay: "2500", firstAskModel: "claude-opus-4-1", modelsDelay: "300" }, { modelsDelay: "300" });
    await change.first;
    await waited(2_500);
    const after = await sent(change.port, { method: "GET", path: "/v1/models" });

    expect(change.sentBeforeTheChange).toBe(true);
    expect(listedIds(change.second.body)).toEqual([MODEL, "claude-haiku-4-5"]);
    expect(listedIds(after.body)).toEqual([MODEL, "claude-haiku-4-5"]);
  }, RUN_BOUND);

  it("keeps the newer round's answer and slots when a round its budget closed answers late for a provider both ask", async () => {
    const change = await changedDuringARound({ firstAskDelay: "4000", firstAskModel: "claude-opus-4-1", modelsDelay: "300" }, { activateDelay: "2600", modelsDelay: "300" });
    const first = await change.first;
    await waited(1_800);
    const after = await sent(change.port, { method: "GET", path: "/v1/models" });
    const haiku = await sent(change.port, { path: "/v1/messages", body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }) });

    expect(change.sentBeforeTheChange).toBe(true);
    expect(listedIds(first.body)).toEqual([]);
    expect(listedIds(change.second.body)).toEqual([MODEL, "claude-haiku-4-5"]);
    expect(listedIds(after.body)).toEqual([MODEL, "claude-haiku-4-5"]);
    expect(haiku.status, haiku.body).toBe(200);
    expect(JSON.parse(haiku.body)).toMatchObject({ content: [{ type: "text", text: "served by zulu" }] });
  }, RUN_BOUND);

  it("settles a request waiting on an open round when the proxy deactivates, and starts no ask after", async () => {
    const port = await freePort();
    const run = await started([proxyInstall(port), providerInstall("alpha", "plain", { modelsDelay: "3000" })]);
    const probe = run.host.service<{ asks: number }>("alpha", "alpha:probe")!;

    const waiting = sent(port, { method: "GET", path: "/v1/models" }).then(
      () => "settled",
      () => "settled",
    );
    await expect.poll(() => probe.asks).toBe(1);
    await run.host.stop();
    const outcome = await Promise.race([waiting, waited(2_000).then(() => "hung")]);
    await waited(3_500);

    expect(outcome).toBe("settled");
    expect(probe.asks).toBe(1);
  }, RUN_BOUND);

  it("lists the whole catalog to two requests arriving together while the first round is open", async () => {
    const port = await freePort();
    const slow = { modelsDelay: "300" };
    await started([proxyInstall(port), providerInstall("alpha", "plain", slow), providerInstall("beta", "plain", { ...slow, model: "claude-haiku-4-5" })]);

    const answers = await Promise.all([sent(port, { method: "GET", path: "/v1/models" }), sent(port, { method: "GET", path: "/v1/models" })]);

    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body).data.map((model: { id: string }) => model.id)).toEqual([MODEL, "claude-haiku-4-5"]);
    }
  }, RUN_BOUND);

  it("falls to the next provider when a stream fails before its first byte", async () => {
    const port = await freePort();
    await started([proxyInstall(port, chainOfBoth()), providerInstall("alpha", "stream-fails-first"), providerInstall("beta", "stream")]);

    const answer = await sent(port, { path: "/v1/messages", body: STREAMED_MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/event-stream");
    expect(answer.body).toContain("streamed by beta");
    expect(answer.body).not.toContain("event: error");
  }, RUN_BOUND);

  it("refuses a request carrying an Origin", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    const answer = await sent(port, { path: "/v1/messages", headers: { origin: "http://example.org" }, body: MESSAGES });

    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toMatchObject({ type: "error", error: { type: "loader_proxy_error" } });
  }, RUN_BOUND);

  it("refuses a body over C's limit with 413", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    const answer = await sent(port, { path: "/v1/messages", body: "x".repeat(64 * 1024 * 1024 + 1) });

    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toMatchObject({ type: "error", error: { type: "loader_proxy_error", message: expect.stringContaining("67108864") } });
  }, RUN_BOUND);

  it("answers a body that is no JSON object with 400", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    const answer = await sent(port, { path: "/v1/messages", body: "[1, 2]" });

    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  }, RUN_BOUND);

  it("with no provider installed, sends a messages request upstream as C's step answers", async () => {
    const port = await freePort();
    await started([proxyInstall(port)]);

    const answer = await sent(port, { path: "/v1/messages", body: MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(answer.headers["x-upstream"]).toBe("fake");
    expect(upstream.received[0]).toMatchObject({ method: "POST", url: "/v1/messages", body: MESSAGES });
  }, RUN_BOUND);

  it("with no provider installed, sends a messages request upstream without a placeholder x-api-key", async () => {
    const port = await freePort();
    await started([proxyInstall(port)]);

    const answer = await sent(port, { path: "/v1/messages", headers: { "x-api-key": "Bearer sk-ant-loader-proxy" }, body: MESSAGES });

    expect(answer.status, answer.body).toBe(200);
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]?.headers["x-api-key"]).toBeUndefined();
  }, RUN_BOUND);

  it("lists the providers' models and answers health locally", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    const listed = await sent(port, { method: "GET", path: "/v1/models" });
    const health = await sent(port, { method: "GET", path: "/health" });

    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({ data: [{ id: MODEL, display_name: MODEL }], first_id: MODEL, has_more: false });
    expect(health).toMatchObject({ status: 200, body: "ok" });
    expect(upstream.received).toHaveLength(0);
  }, RUN_BOUND);

  it("answers C's 404 for a model id whose escape is malformed", async () => {
    const port = await freePort();
    await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    const looked = await sent(port, { method: "GET", path: "/v1/models/%E0%A4" });

    expect(looked.status, looked.body).toBe(404);
    expect(JSON.parse(looked.body)).toMatchObject({ type: "error", error: { type: "not_found_error" } });
  }, RUN_BOUND);

  it("refuses its activation in C's words when the port is already taken", async () => {
    const port = await freePort();
    await blocked(port);
    const run = await started([proxyInstall(port), providerInstall("alpha", "plain")]);

    expect(readyRecord(run.home)).toMatchObject({
      refused: expect.stringContaining(`claude-code-proxy is enabled but did not start: its activate threw: port ${port} on 127.0.0.1 is already in use, so the proxy cannot listen; fix: stop what listens on port ${port}`),
      fix: "fix or disable claude-code-proxy",
    });
    expect(readyRecord(run.home).refused).toContain(`set proxy.port in ${join(run.home.base, "application", "config", "claude-code-proxy.json")} to a free port`);
  }, RUN_BOUND);
});

