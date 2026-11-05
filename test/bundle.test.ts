import { isBuiltin } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundlePlugin } from "@forebay/host";
import type { FrontDoor } from "@forebay/host";
import type { Plugin } from "@weivel/typescript";

const REPOSITORY = join(import.meta.dirname, "..");

let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "claude-code-proxy-bundle-"));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("the catalog item", () => {
  it("bundles into the entry its manifest names, with the translator inlined", async () => {
    const bundled = await bundlePlugin(REPOSITORY, out);
    expect(bundled.id).toBe("claude-code-proxy");
    expect(Object.keys(bundled.files).sort()).toEqual(["dist/plugin.js", "plugin.json"]);
    const manifest = JSON.parse(readFileSync(join(out, "plugin.json"), "utf8"));
    expect(manifest.capabilities).toEqual(["front-door"]);
    expect(manifest.config.defaults.upstream).toBe("https://api.anthropic.com");
    const imports = [...readFileSync(join(out, "dist", "plugin.js"), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map((match) => match[1] as string);
    expect(imports.filter((specifier) => !isBuiltin(specifier))).toEqual([]);
  });

  it("runs from the bundle alone and answers a decode through the inlined translator", async () => {
    await bundlePlugin(REPOSITORY, out);
    writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
    const loaded = (await import(pathToFileURL(join(out, "dist", "plugin.js")).href)) as { default: Plugin };
    let door: FrontDoor | undefined;
    await loaded.default.activate({
      capability: (id: string) => ({ id }),
      config: { get: () => "https://api.anthropic.com" },
      provide: (_type: unknown, implementation: FrontDoor) => {
        door = implementation;
      },
    } as never);
    const body = JSON.stringify({ model: "claude-opus-4-1", messages: [{ role: "user", content: "hi" }] });
    const answer = await door?.decodeRequest({ method: "POST", path: "/v1/messages", headers: {}, body });
    expect(answer).toMatchObject({ model: "claude-opus-4-1", stream: false });
  });
});
