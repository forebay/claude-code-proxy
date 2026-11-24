import type { ServerResponse } from "node:http";
import type { Anthropic, Body, Enums, Handle, Provider, ProviderEnums, ProviderNextAnswer, Report } from "./services.js";
import { headersOf } from "./wire.js";

/** One request's stream to the client: the encoder C keeps one provider's stream state in, and whether a byte went out. */
export class Relay {
  readonly #anthropic: Anthropic;
  readonly #enums: Enums;
  readonly #response: ServerResponse;
  readonly #signal: AbortSignal;
  #encoder: Handle | undefined;
  #wrote = false;

  constructor(anthropic: Anthropic, enums: Enums, response: ServerResponse, signal: AbortSignal) {
    this.#anthropic = anthropic;
    this.#enums = enums;
    this.#response = response;
    this.#signal = signal;
  }

  /**
   * Reads a provider's stream to its end or its failure through an encoder of its own, answering the report for
   * `step`, or undefined once the client went away.
   *
   * @implNote A stream is read by one thread at a time, so once the client went away the stream is released only
   * after the `next` still running on it has settled, and no `next` follows.
   */
  async relayed(provider: Provider, stream: unknown): Promise<Report | undefined> {
    let pending: Promise<ProviderNextAnswer> | undefined;
    try {
      this.#encoder ??= await this.#anthropic.stream_encoder_open({});
      while (!this.#signal.aborted) {
        pending = nextOf(provider, stream, this.#enums.provider);
        const next = await this.#unlessGone(pending);
        if (next === undefined) return undefined;
        pending = undefined;
        if (next.kind === this.#enums.provider.forebay_provider_next_kind.FOREBAY_PROVIDER_NEXT_EVENT) {
          await this.#written((encoder) => this.#anthropic.stream_encode({ argument: { encoder, events: [next.event] } }));
        } else if (next.kind === this.#enums.provider.forebay_provider_next_kind.FOREBAY_PROVIDER_NEXT_END) {
          await this.#written((encoder) => this.#anthropic.stream_encode_finish({ argument: { encoder, events: [] } }));
          this.#response.end();
          return { kind: this.#enums.routing.forebay_report_kind.FOREBAY_REPORT_STREAMED };
        } else {
          if (!this.#wrote) this.release();
          return { kind: this.#enums.routing.forebay_report_kind.FOREBAY_REPORT_STREAM_FAILED, after_bytes: this.#wrote ? 1 : 0, message: next.failure ?? null };
        }
      }
      return undefined;
    } finally {
      await pending;
      await released(provider, stream);
    }
  }

  /** Writes the IR error event C names after a stream failed past its first byte, and ends the stream. */
  async endWithError(errorType: string | undefined, message: string | undefined): Promise<void> {
    const event = { kind: this.#enums.anthropic.forebay_ir_event_kind.FOREBAY_IR_EVENT_ERROR, error_type: errorType ?? null, message: message ?? null };
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

  /** What `pending` answers, or undefined as soon as the client went away. */
  async #unlessGone(pending: Promise<ProviderNextAnswer>): Promise<ProviderNextAnswer | undefined> {
    let abandon = (): void => undefined;
    const gone = new Promise<undefined>((resolve) => (abandon = () => resolve(undefined)));
    this.#signal.addEventListener("abort", abandon, { once: true });
    try {
      const answer = await Promise.race([pending, gone]);
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

function nextOf(provider: Provider, stream: unknown, enums: ProviderEnums): Promise<ProviderNextAnswer> {
  return provider.next({ stream }).catch((error: unknown) => ({ kind: enums.forebay_provider_next_kind.FOREBAY_PROVIDER_NEXT_FAILURE, failure: error instanceof Error ? error.message : String(error) }));
}

/** Frees the stream through the contract's `release_stream` when the provider offers it, or a handle's own release. */
async function released(provider: Provider, stream: unknown): Promise<void> {
  try {
    if (typeof provider.release_stream === "function") {
      await provider.release_stream({ stream });
      return;
    }
    const release = (stream as { release?: unknown } | null)?.release;
    if (typeof release === "function") release.call(stream);
  } catch {
    // A release that fails leaves this consumer nothing more to free.
  }
}
