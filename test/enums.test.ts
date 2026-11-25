import { requireEnums, type DescribedEnums, type EnumNames, type PluginContext } from "@weivel/typescript/context";
import { describe, expect, it } from "vitest";
import plugin from "../src/plugin.js";
import { ANTHROPIC_ENUM_NAMES, LOG_ENUM_NAMES, PROVIDER_ENUM_NAMES, ROUTING_ENUM_NAMES } from "../src/services.js";

/** Enums as a description would carry every name `names` lists, numbered in order, less the entry `without`. */
function describedAs(names: EnumNames, without?: string): DescribedEnums {
  return Object.fromEntries(Object.entries(names).map(([name, entries]) => [name, Object.fromEntries(entries.filter((entry) => entry !== without).map((entry, index) => [entry, index + 1]))]));
}

/** A context reaching services that are bare objects, whose enums are `routing` for routing and every name for the rest. */
function contextWith(routing: DescribedEnums): PluginContext {
  const services: Record<string, object> = { routing: {}, anthropic: {}, "weivel.log": {}, "weivel.config": {} };
  const enums = new Map<object, DescribedEnums>([
    [services.routing!, routing],
    [services.anthropic!, describedAs(ANTHROPIC_ENUM_NAMES)],
    [services["weivel.log"]!, describedAs(LOG_ENUM_NAMES)],
  ]);
  return {
    service: (id: string) => ({ id }),
    capability: (id: string) => ({ id }),
    requireEnums,
    services: { get: (type: { id: string }) => services[type.id], enumsOf: (service: object) => enums.get(service) },
    capabilities: { enumsOf: () => describedAs(PROVIDER_ENUM_NAMES), all: () => [] },
  } as unknown as PluginContext;
}

describe("the activation", () => {
  it("is refused, naming the entry, when a description lacks one the plugin reads", async () => {
    await expect(plugin.activate(contextWith(describedAs(ROUTING_ENUM_NAMES, "FOREBAY_STEP_DONE")))).rejects.toThrow("The enum forebay_step_kind of routing has no entry FOREBAY_STEP_DONE.");
  });
});
