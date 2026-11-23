import type { ServerResponse } from "node:http";
import { IR_EVENT_ERROR, PROVIDER_NEXT, REPORT } from "./kinds.js";
import type { Anthropic, Handle, Provider, ProviderNextAnswer, Report } from "./services.js";

const STREAM_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" };

/** One request's stream to the client: the encoder C keeps its state in, and whether a byte went out yet. */
export class Relay {
  readonly #anthropic: Anthropic;
  readonly #response: ServerResponse;
  readonly #signal: AbortSignal;
  #encoder: Handle | undefined;
  #wrote = false;

  constructor(anthropic: Anthropic, response: ServerResponse, signal: AbortSignal) {
    this.#anthropic = anthropic;
    this.#response = response;
    this.#signal = signal;
  }

  /** Reads a provider's stream to its end or its failure, answering the report for `step`, or undefined once the client went away. */
  async relayed(provider: Provider, stream: unknown): Promise<Report | undefined> {
    try {
      for (;;) {
        const next = await nextOf(provider, stream);
        if (this.#signal.aborted) return undefined;
        if (next.kind === PROVIDER_NEXT.EVENT) {
          await this.#written((encoder) => this.#anthropic.stream_encode({ argument: { encoder, events: [next.event] } }));
        } else if (next.kind === PROVIDER_NEXT.END) {
          await this.#written((encoder) => this.#anthropic.stream_encode_finish({ argument: { encoder, events: [] } }));
          this.#response.end();
          return { kind: REPORT.STREAMED };
        } else {
          return { kind: REPORT.STREAM_FAILED, after_bytes: this.#wrote ? 1 : 0, message: next.failure ?? null };
        }
      }
    } finally {
      released(stream);
    }
  }

  /** Writes the IR error event C names after a stream failed past its first byte, and ends the stream. */
  async endWithError(errorType: string | undefined, message: string | undefined): Promise<void> {
    const event = { kind: IR_EVENT_ERROR, error_type: errorType ?? null, message: message ?? null };
    try {
      await this.#written((encoder) => this.#anthropic.stream_encode({ argument: { encoder, events: [event] } }));
    } finally {
      this.#response.end();
    }
  }

  get wrote(): boolean {
    return this.#wrote;
  }

  release(): void {
    this.#encoder?.release();
    this.#encoder = undefined;
  }

  async #written(encode: (encoder: Handle) => Promise<{ bytes?: Uint8Array }>): Promise<void> {
    this.#encoder ??= await this.#anthropic.stream_encoder_open({});
    const body = await encode(this.#encoder);
    if (body.bytes === undefined || body.bytes.length === 0) return;
    if (!this.#wrote) this.#response.writeHead(200, STREAM_HEADERS);
    this.#wrote = true;
    if (!this.#response.write(body.bytes)) await this.#drained();
  }

  #drained(): Promise<void> {
    if (this.#signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const settle = (): void => {
        this.#response.off("drain", settle);
        this.#signal.removeEventListener("abort", settle);
        resolve();
      };
      this.#response.once("drain", settle);
      this.#signal.addEventListener("abort", settle, { once: true });
    });
  }
}

async function nextOf(provider: Provider, stream: unknown): Promise<ProviderNextAnswer> {
  try {
    return await provider.next({ stream });
  } catch (error) {
    return { kind: PROVIDER_NEXT.FAILURE, failure: error instanceof Error ? error.message : String(error) };
  }
}

/** A stream a C provider answered is a handle the binding frees; one a TypeScript provider answered is its own value. */
function released(stream: unknown): void {
  const release = (stream as { release?: unknown } | null)?.release;
  if (typeof release === "function") release.call(stream);
}
