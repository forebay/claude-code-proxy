import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RateLimitReplyArgument, WireReply } from "@forebay/host";
import { contractProblems } from "../test/contract-schemas.js";
import { rateLimitReply } from "./rate-limit-reply.js";

interface Vector {
  name: string;
  input: RateLimitReplyArgument;
  expected: WireReply;
}

const VECTORS = join(import.meta.dirname, "..", "test", "vectors", "rate-limit");
const vectors: Vector[] = readdirSync(VECTORS).map((file) => JSON.parse(readFileSync(join(VECTORS, file), "utf8")) as Vector);

describe("rateLimitReply vectors", () => {
  it("has vectors for both java cases and for each reset header", () => {
    const names = vectors.map((vector) => vector.name);
    expect(names).toEqual(expect.arrayContaining(["upstream-429-reconciles-reset-and-strips-headers", "no-upstream-falls-back-to-sixty-seconds", "reset-header-5h-only", "reset-header-unified-only", "reset-header-none"]));
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const reply = rateLimitReply(vector.input);
    expect(reply).toEqual(vector.expected);
    expect(contractProblems("RateLimitReplyAnswer", reply)).toEqual([]);
  });
});

describe("rateLimitReply", () => {
  it("writes the middle dot, which is not a dash", () => {
    const reply = rateLimitReply({ upstreamHeaders: {}, now: 1000, timeZone: "UTC" });
    expect(JSON.parse(reply.body).error.message).toContain("limit · try");
    expect(reply.body).not.toMatch(/[\u2013\u2014]/);
  });

  it("does not change the headers it was given", () => {
    const upstreamHeaders = { "content-length": "10" };
    rateLimitReply({ upstreamHeaders, now: 1000, timeZone: "UTC" });
    expect(upstreamHeaders).toEqual({ "content-length": "10" });
  });
});
