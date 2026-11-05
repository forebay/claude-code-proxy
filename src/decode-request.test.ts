import { describe, expect, it } from "vitest";
import type { IrFailure, WireRequest } from "@forebay/host";
import { anthropicTranslator } from "anthropic-translator";
import { contractProblems } from "../test/contract-schemas.js";
import { decodeRequest } from "./decode-request.js";

const MESSAGES_BODY = { model: "claude-sonnet-4-5", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] };

function wire(overrides: Partial<WireRequest>): WireRequest {
  return { method: "POST", path: "/v1/messages", headers: {}, body: JSON.stringify(MESSAGES_BODY), ...overrides };
}

describe("decodeRequest", () => {
  it("answers what the translator decodes, for a post to /v1/messages", () => {
    const answer = decodeRequest(wire({}));
    expect(answer).toEqual(anthropicTranslator.decodeRequest(MESSAGES_BODY));
    expect(contractProblems("DecodeRequestAnswer", answer)).toEqual([]);
  });

  it("ignores the query", () => {
    expect(decodeRequest(wire({ path: "/v1/messages?beta=true" }))).toEqual(anthropicTranslator.decodeRequest(MESSAGES_BODY));
  });

  it.each([
    ["a get of the model list", { method: "GET", path: "/v1/models", body: "" }],
    ["a get of /v1/messages", { method: "GET", path: "/v1/messages", body: "" }],
    ["count_tokens", { path: "/v1/messages/count_tokens" }],
    ["a path it does not know", { path: "/v1/complete" }],
  ])("passes %s through undecoded", (_label, overrides) => {
    const answer = decodeRequest(wire(overrides));
    expect(answer).toEqual({ passThrough: true });
    expect(contractProblems("DecodeRequestAnswer", answer)).toEqual([]);
  });

  it.each([["text that is not json", "{not json"], ["json that is not an object", "[1]"], ["an empty body", ""]])("answers a 400 in anthropic's error shape for %s", (_label, body) => {
    const answer = decodeRequest(wire({ body })) as IrFailure;
    expect(answer.status).toBe(400);
    expect(answer.headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(answer.body);
    expect(parsed.type).toBe("error");
    expect(parsed.error.type).toBe("invalid_request_error");
    expect(typeof parsed.error.message).toBe("string");
    expect(contractProblems("DecodeRequestAnswer", answer)).toEqual([]);
  });
});
