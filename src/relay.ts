import type { ServerResponse } from "node:http";
import { IR_EVENT_ERROR, PROVIDER_NEXT, REPORT } from "./kinds.js";
import type { Anthropic, Body, Handle, Provider, ProviderNextAnswer, Report } from "./services.js";
import { headersOf } from "./wire.js";

/** One request's stream to the client: the encoder C keeps one provider's stream state in, and whether a byte went out. */
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
      while (!this.#signal.aborted) {
        const next = await this.#nextOf(provider, stream);
        if (next === undefined) return undefined;
        if (next.kind === PROVIDER_NEXT.EVENT) {
          await this.#written((encoder) => this.#anthropic.stream_encode({ argument: { encoder, events: [next.event] } }));
        } else if (next.kind === PROVIDER_NEXT.END) {
          await this.#written((encoder) => this.#anthropic.stream_encode_finish({ argument: { encoder, events: [] } }));
          this.#response.end();
          return { kind: REPORT.STREAMED };
        } else {
          if (!this.#wrote) this.release();
          return { kind: REPORT.STREAM_FAILED, after_bytes: this.#wrote ? 1 : 0, message: next.failure ?? null };
        }
      }
      return undefined;
    } finally {
      released(provider, stream);
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

  release(): void {
    this.#encoder?.release();
    this.#encoder = undefined;
  }

  /** The provider's next answer, or undefined once the client went away while it was awaited. */
  async #nextOf(provider: Provider, stream: unknown): Promise<ProviderNextAnswer | undefined> {
    let abandon = (): void => undefined;
    const gone = new Promise<undefined>((resolve) => (abandon = () => resolve(undefined)));
    this.#signal.addEventListener("abort", abandon, { once: true });
    const next = provider.next({ stream }).catch((error: unknown) => ({ kind: PROVIDER_NEXT.FAILURE, failure: error instanceof Error ? error.message : String(error) }));
    try {
      const answer = await Promise.race([next, gone]);
      return this.#signal.aborted ? undefined : answer;
    } finally {
      this.#signal.removeEventListener("abort", abandon);
    }
  }

  async #written(encode: (encoder: Handle) => Promise<Body>): Promise<void> {
    this.#encoder ??= await this.#anthropic.stream_encoder_open({});
    const body = await encode(this.#encoder);
    if (body.bytes.length === 0) return;
    if (!this.#wrote) this.#response.writeHead(body.status, headersOf(body.headers));
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

/** Frees the stream through the contract's `release_stream` when the provider offers it, or a handle's own release. */
function released(provider: Provider, stream: unknown): void {
  if (typeof provider.release_stream === "function") {
    provider.release_stream({ stream });
    return;
  }
  const release = (stream as { release?: unknown } | null)?.release;
  if (typeof release === "function") release.call(stream);
}
