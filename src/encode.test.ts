import { describe, expect, it } from "vitest";
import type { IrResponse, IrStreamEvent } from "@forebay/host";
import { anthropicTranslator } from "anthropic-translator";
import { contractProblems } from "../test/contract-schemas.js";
import { encodeEvent, encodeResponse } from "./encode.js";

const RESPONSE: IrResponse = { id: "msg_1", model: "claude-sonnet-4-5", stopReason: "end_turn", content: [{ kind: "text", text: "hello" }], usage: { inputTokens: 3, outputTokens: 2 } };

const EVENTS: IrStreamEvent[] = [
  { event: "message_start", id: "msg_1", model: "claude-sonnet-4-5", role: "assistant" },
  { event: "content_block_start", index: 0, blockKind: "text" },
  { event: "text_delta", index: 0, text: "hel" },
  { event: "content_block_stop", index: 0 },
  { event: "message_stop" },
];

async function wholeStream(events: IrStreamEvent[]): Promise<string[]> {
  const encoder = anthropicTranslator.encodeStream();
  const writer = encoder.writable.getWriter();
  const written = (async () => {
    for (const event of events) await writer.write(event);
    await writer.close();
  })();
  const chunks: string[] = [];
  const reader = encoder.readable.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
  await written;
  return chunks;
}

describe("encodeResponse", () => {
  it("answers the translator's wire body as a 200 json reply", () => {
    const reply = encodeResponse(RESPONSE);
    expect(reply.status).toBe(200);
    expect(reply.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(reply.body)).toEqual(anthropicTranslator.encodeResponse(RESPONSE));
    expect(contractProblems("EncodeResponseAnswer", reply)).toEqual([]);
  });
});

describe("encodeEvent", () => {
  it("answers one server-sent-event frame in the translator's encoding", async () => {
    const answer = await encodeEvent({ event: "text_delta", index: 0, text: "hel" });
    expect(answer.chunks).toEqual(['event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n\n']);
    expect(contractProblems("EncodeEventAnswer", answer)).toEqual([]);
  });

  it("encodes a whole stream event by event the way one stream would", async () => {
    const perEvent = (await Promise.all(EVENTS.map(encodeEvent))).flatMap((answer) => answer.chunks);
    expect(perEvent).toEqual(await wholeStream(EVENTS));
  });
});
