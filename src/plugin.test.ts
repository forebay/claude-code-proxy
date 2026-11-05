import { describe, expect, it } from "vitest";
import type { FrontDoor } from "@forebay/host";
import type { PluginContext } from "@weivel/typescript";
import plugin from "./plugin.js";

interface Provided {
  id: string;
  implementation: FrontDoor;
}

function context(settings: Record<string, unknown>, provided: Provided[]): PluginContext {
  return {
    capability: (id: string) => ({ id }),
    config: { get: (key: string) => settings[key], all: () => settings },
    provide: (type: { id: string }, implementation: FrontDoor) => provided.push({ id: type.id, implementation }),
  } as unknown as PluginContext;
}

describe("plugin", () => {
  it("provides the front-door capability, pointing the profile at the configured upstream", async () => {
    const provided: Provided[] = [];
    await plugin.activate(context({ upstream: "http://127.0.0.1:4010" }, provided));
    expect(provided.map((entry) => entry.id)).toEqual(["front-door"]);
    expect((await provided[0]?.implementation.profile())?.upstream).toBe("http://127.0.0.1:4010");
  });

  it("refuses to activate with no upstream setting", async () => {
    await expect(Promise.resolve().then(() => plugin.activate(context({}, [])))).rejects.toThrow(/upstream/);
  });
});
