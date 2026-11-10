import type { Profile } from "@forebay/host";

export const PROVIDER_ID = "claude-code-provider";

export function profile(upstream: string): Profile {
  return {
    tierSourceProvider: PROVIDER_ID,
    tierOrder: ["opus", "sonnet", "haiku", "fable"],
    tierFallback: ["opus", "sonnet", "haiku"],
    tierRegex: "^claude-([a-z]+)-\\d",
    nativeModelPattern: "^claude-",
    envPrefix: "ANTHROPIC",
    defaultContext: 200000,
    defaultOutput: 64000,
    upstream,
  };
}
