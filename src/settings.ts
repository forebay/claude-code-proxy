import { join } from "node:path";
import type { Config, Paths, RoutingProfile } from "./services.js";

const SETTINGS_FILE_NAME = "config.json";

export interface ProxySettings {
  readonly upstream: unknown;
  readonly port: unknown;
  readonly placeholderAuthorization: unknown;
  readonly profile: RoutingProfile;
  readonly loginCommand: unknown;
  readonly settingsFile: string;
  /** The settings record `model_map` reads the stored map from, `routing` as the config holds it. */
  readonly record: { readonly routing: unknown };
}

type Tree = Readonly<Record<string, unknown>>;

/** A setting whole as the config holds it, undefined when it is neither stored nor defaulted. */
async function settingOf(config: Config, key: string): Promise<unknown> {
  const answer = await config.get_tree({ key });
  return typeof answer === "symbol" ? undefined : answer;
}

function member(record: unknown, name: string): unknown {
  return typeof record === "object" && record !== null && !Array.isArray(record) ? (record as Tree)[name] : undefined;
}

function profileOf(routing: unknown): RoutingProfile {
  return {
    tier_source_provider: member(routing, "tierSourceProvider"),
    tier_order: member(routing, "tierOrder"),
    tier_fallback: member(routing, "tierFallback"),
    tier_regex: member(routing, "tierRegex"),
    native_model_pattern: member(routing, "nativeModelPattern"),
    default_context: member(routing, "defaultContext"),
    default_output: member(routing, "defaultOutput"),
  };
}

export async function readSettings(config: Config, paths: Paths): Promise<ProxySettings> {
  const routing = await settingOf(config, "routing");
  return {
    upstream: await settingOf(config, "upstream"),
    port: await settingOf(config, "proxy.port"),
    placeholderAuthorization: await settingOf(config, "proxy.placeholderAuthorization"),
    profile: profileOf(routing),
    loginCommand: member(routing, "loginCommand"),
    settingsFile: join(await paths.config({}), SETTINGS_FILE_NAME),
    record: { routing },
  };
}
