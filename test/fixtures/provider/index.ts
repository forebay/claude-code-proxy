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
  readonly services: { get(service: unknown): unknown };
}

interface Stream {
  readonly events: object[];
  readonly failure: string | undefined;
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
  if (mode === "stream") return { kind: STREAM, stream: { events: streamed(request.model, `streamed by ${name}`), failure: undefined } };
  return { kind: STREAM, stream: { events: streamed(request.model, "partial").slice(0, 3), failure: `${name} broke mid stream` } };
}

export default {
  async activate(context: Context): Promise<void> {
    const config = context.services.get(context.service("weivel.config")) as Config;
    const mode = await text(config, "mode");
    const name = await text(config, "name");
    const model = await text(config, "model");
    context.provide(context.capability("forebay.provider"), {
      async models() {
        return { provider: { provider: name, models: [{ id: model, name: model }], has_ranking: 0, default_model: model } };
      },
      async handle(input: { argument: { request: { model: string } } }) {
        return handled(mode, name, input.argument.request);
      },
      async next(input: { stream: Stream }) {
        const event = input.stream.events.shift();
        if (event !== undefined) return { kind: EVENT, event };
        return input.stream.failure === undefined ? { kind: END } : { kind: STREAM_FAILED, failure: input.stream.failure };
      },
    });
  },
};
