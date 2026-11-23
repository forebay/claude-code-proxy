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

/** A stream the test provider answers: its events, how it ends, and, for one that hangs, what its release settles. */
interface Stream {
  readonly events: object[];
  readonly failure: string | undefined;
  readonly hangs: boolean;
  released: boolean;
  wake?: () => void;
}

/** What the test reads of the provider through the service it registers. */
interface Probe {
  released: number;
}

const TEXT = 1;
const RESPONSE = 1;
const FAILURE = 2;
const STREAM = 3;
const EVENT = 1;
const END = 2;
const STREAM_FAILED = 3;

async function text(config: Config, key: string): Promise<string> {
  const answer = await config.get({ key });
  if (typeof answer === "symbol" || answer.value.kind !== TEXT || answer.value.text === null) throw new Error(`the test provider's setting ${key} holds no text`);
  return answer.value.text;
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

function stream(events: object[], failure: string | undefined, hangs = false): object {
  return { kind: STREAM, stream: { events, failure, hangs, released: false } satisfies Stream };
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
  if (mode === "hang") return stream(streamed(request.model, "first").slice(0, 3), undefined, true);
  return stream(streamed(request.model, "partial").slice(0, 3), `${name} broke mid stream`);
}

async function next(input: { stream: Stream }): Promise<object> {
  const { stream } = input;
  const event = stream.events.shift();
  if (event !== undefined) return { kind: EVENT, event };
  if (stream.hangs && !stream.released) await new Promise<void>((resolve) => (stream.wake = resolve));
  return stream.failure === undefined ? { kind: END } : { kind: STREAM_FAILED, failure: stream.failure };
}

export default {
  async activate(context: Context): Promise<void> {
    const config = context.services.get(context.service("weivel.config")) as Config;
    const mode = await text(config, "mode");
    const name = await text(config, "name");
    const model = await text(config, "model");
    const probe: Probe = { released: 0 };
    context.services.register(context.service(`${name}:probe`), probe);
    context.provide(context.capability("forebay.provider"), {
      async models() {
        return { provider: { provider: name, models: [{ id: model, name: model }], has_ranking: 0, default_model: model } };
      },
      async handle(input: { argument: { request: { model: string } } }) {
        return handled(mode, name, input.argument.request);
      },
      next,
      release_stream(input: { stream: Stream }) {
        input.stream.released = true;
        input.stream.wake?.();
        probe.released += 1;
      },
    });
  },
};
