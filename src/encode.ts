import type { EncodeEventAnswer, EncodeResponseAnswer, IrResponse, IrStreamEvent } from "@forebay/host";
import { anthropicTranslator } from "anthropic-translator";

export function encodeResponse(response: IrResponse): EncodeResponseAnswer {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(anthropicTranslator.encodeResponse(response)),
  };
}

async function drained(readable: ReadableStream<string>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = readable.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
  return chunks;
}

/** @implNote The translator's encoder keeps no state between events, so a stream per event answers the same frames as one stream for all. */
export async function encodeEvent(event: IrStreamEvent): Promise<EncodeEventAnswer> {
  const encoder = anthropicTranslator.encodeStream();
  const writer = encoder.writable.getWriter();
  const written = writer.write(event).then(() => writer.close());
  const [chunks] = await Promise.all([drained(encoder.readable), written]);
  return { chunks };
}
