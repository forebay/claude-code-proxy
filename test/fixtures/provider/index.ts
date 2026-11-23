interface SettingAnswer {
  readonly value: { readonly kind: number; readonly text: string | null };
}

interface Config {
  get(input: { readonly key: string }): Promise<SettingAnswer | symbol>;
}

interface Context {
  service(id: string): unknown;
  capability(id: string): unknown;
  provide(capability: unknown, implementation: object): void;
  readonly services: { get(service: unknown): unknown; register(service: unknown, object: object): unknown };
}

/** A stream the test provider answers: its events, how it ends, how long its last `next` waits, and whether one runs. */
interface Stream {
  readonly events: object[];
  readonly failure: string | undefined;
  readonly hangMilliseconds: number;
  reading: boolean;
}

/** What the test reads of the provider through the service it registers. */
interface Probe {
  released: number;
  releasedWhileReading: number;
}

const TEXT = 1;
const RESPONSE = 1;
const FAILURE = 2;
const STREAM = 3;
const EVENT = 1;
const END = 2;
const STREAM_FAILED = 3;

async function optionalText(config: Config, key: string): Promise<string | undefined> {
  const answer = await config.get({ key });
  return typeof answer === "symbol" || answer.value.kind !== TEXT || answer.value.text === null ? undefined : answer.value.text;
}

async function text(config: Config, key: string): Promise<string> {
  const value = await optionalText(config, key);
  if (value === undefined) throw new Error(`the test provider's setting ${key} holds no text`);
  return value;
}

function waited(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function streamed(model: string, text: string): object[] {
  return [
    { kind: 1, id: "msg_test", model, role: "assistant" },
    { kind: 2, index: 0, block_kind: 1 },
    { kind: 3, index: 0, text },
    { kind: 7, index: 0 },
    { kind: 8, stop_reason: "end_turn" },
    { kind: 9 },
  ];
}

function stream(events: object[], failure: string | undefined, hangMilliseconds = 0): object {
  return { kind: STREAM, stream: { events, failure, hangMilliseconds, reading: false } satisfies Stream };
}

function handled(mode: string, name: string, request: { model: string }): object {
  if (mode === "plain") {
    return { kind: RESPONSE, response: { id: "msg_test", model: request.model, stop_reason: "end_turn", content: [{ kind: 1, text: `served by ${name}` }] } };
  }
  if (mode === "rate-limited") {
    const headers = [
      { name: "content-type", value: "application/json" },
      { name: "retry-after", value: "120" },
      { name: "x-upstream", value: name },
    ];
    return { kind: FAILURE, failure: { status: 429, headers, body: `{"limited":"${name}"}` } };
  }
  if (mode === "stream") return stream(streamed(request.model, `streamed by ${name}`), undefined);
  if (mode === "stream-fails-first") return stream([], `${name} broke before its first event`);
  if (mode === "hang") return stream(streamed(request.model, "first").slice(0, 3), undefined, 500);
  return stream(streamed(request.model, "partial").slice(0, 3), `${name} broke mid stream`);
}

/** @implNote A hanging stream's last `next` settles on its own after its wait, as a provider bounds its upstream wait. */
async function next(input: { stream: Stream }): Promise<object> {
  const { stream } = input;
  const event = stream.events.shift();
  if (event !== undefined) return { kind: EVENT, event };
  stream.reading = true;
  await waited(stream.hangMilliseconds);
  stream.reading = false;
  return stream.failure === undefined ? { kind: END } : { kind: STREAM_FAILED, failure: stream.failure };
}

export default {
  async activate(context: Context): Promise<void> {
    const config = context.services.get(context.service("weivel.config")) as Config;
    const mode = await text(config, "mode");
    const name = await text(config, "name");
    const model = await text(config, "model");
    const modelsDelay = Number(await optionalText(config, "modelsDelay"));
    const probe: Probe = { released: 0, releasedWhileReading: 0 };
    context.services.register(context.service(`${name}:probe`), probe);
    context.provide(context.capability("forebay.provider"), {
      async models() {
        if (mode === "models-refused") throw new Error(`${name}\u0000broke`);
        if (modelsDelay > 0) await waited(modelsDelay);
        return { provider: { provider: name, models: [{ id: model, name: model }], has_ranking: 0, default_model: model } };
      },
      async handle(input: { argument: { request: { model: string } } }) {
        return handled(mode, name, input.argument.request);
      },
      next,
      release_stream(input: { stream: Stream }) {
        probe.released += 1;
        if (input.stream.reading) probe.releasedWhileReading += 1;
      },
    });
  },
};
