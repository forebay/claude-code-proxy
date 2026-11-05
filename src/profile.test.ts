import { describe, expect, it } from "vitest";
import { contractProblems } from "../test/contract-schemas.js";
import { profile } from "./profile.js";

describe("profile", () => {
  it("conforms to the front-door contract", () => {
    expect(contractProblems("ProfileAnswer", profile("https://api.anthropic.com"))).toEqual([]);
  });

  it("names claude-code-auth, the plugin id of the provider, as the tier source", () => {
    expect(profile("http://127.0.0.1:1").tierSourceProvider).toBe("claude-code-auth");
  });

  it("carries the anthropic tiers, patterns and limits", () => {
    expect(profile("http://127.0.0.1:1")).toEqual({
      tierSourceProvider: "claude-code-auth",
      tierOrder: ["opus", "sonnet", "haiku", "fable"],
      tierFallback: ["opus", "sonnet", "haiku"],
      tierRegex: "^claude-([a-z]+)-\\d",
      nativeModelPattern: "^claude-",
      envPrefix: "ANTHROPIC",
      defaultContext: 200000,
      defaultOutput: 64000,
      upstream: "http://127.0.0.1:1",
    });
  });

  it("reads each tier out of a claude model name", () => {
    const pattern = new RegExp(profile("u").tierRegex);
    expect(pattern.exec("claude-sonnet-4-5")?.[1]).toBe("sonnet");
    expect(pattern.exec("gpt-4")).toBeNull();
  });
});
