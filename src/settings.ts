import { join } from "node:path";
import { SETTING } from "./kinds.js";
import type { Config, Paths, RoutingProfile, SettingValue } from "./services.js";

const SETTINGS_FILE_NAME = "config.json";
const POSITION = /^\d+$/;

export interface ProxySettings {
  readonly upstream: string;
  readonly port: unknown;
  readonly placeholderAuthorization: string | null;
  readonly profile: RoutingProfile;
  readonly loginCommand: string;
  readonly settingsFile: string;
  /** Every setting as one record, which `model_map` reads the stored map from. */
  readonly record: Record<string, unknown>;
}

type Tree = Record<string, unknown>;

function nativeOf(value: SettingValue): unknown {
  if (value.kind === SETTING.TEXT) return value.text;
  if (value.kind === SETTING.NUMBER) return value.number;
  if (value.kind === SETTING.BOOLEAN) return value.boolean === 1;
  return undefined;
}

function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @implNote weivel.config offers no list kind and flattens a record into dotted keys, so a list is declared as a
 * record keyed by position: this folds the keys back into records and turns each record keyed only by positions
 * into the list they order.
 */
function listed(value: unknown): unknown {
  if (!isTree(value)) return value;
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key) => POSITION.test(key))) {
    return keys.sort((left, right) => Number(left) - Number(right)).map((key) => listed(value[key]));
  }
  return Object.fromEntries(keys.map((key) => [key, listed(value[key])]));
}

function treeOf(settings: readonly { key: string; value: SettingValue }[]): Tree {
  const root: Tree = {};
  for (const { key, value } of settings) {
    const path = key.split(".");
    const leaf = path.pop() ?? key;
    let node = root;
    for (const segment of path) {
      if (!isTree(node[segment])) node[segment] = {};
      node = node[segment] as Tree;
    }
    node[leaf] = nativeOf(value);
  }
  return listed(root) as Tree;
}

function member(tree: Tree, path: string): unknown {
  return path.split(".").reduce<unknown>((node, segment) => (isTree(node) ? node[segment] : undefined), tree);
}

function textOf(tree: Tree, path: string): string | null {
  const value = member(tree, path);
  return typeof value === "string" ? value : null;
}

function numberOf(tree: Tree, path: string): number {
  const value = member(tree, path);
  return typeof value === "number" ? value : 0;
}

function textsOf(tree: Tree, path: string): string[] {
  const value = member(tree, path);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function profileOf(tree: Tree): RoutingProfile {
  return {
    tier_source_provider: textOf(tree, "routing.tierSourceProvider"),
    tier_order: textsOf(tree, "routing.tierOrder"),
    tier_fallback: textsOf(tree, "routing.tierFallback"),
    tier_regex: textOf(tree, "routing.tierRegex"),
    native_model_pattern: textOf(tree, "routing.nativeModelPattern"),
    default_context: numberOf(tree, "routing.defaultContext"),
    default_output: numberOf(tree, "routing.defaultOutput"),
  };
}

export async function readSettings(config: Config, paths: Paths): Promise<ProxySettings> {
  const answer = await config.all({});
  const tree = treeOf(answer.settings ?? []);
  return {
    upstream: textOf(tree, "upstream") ?? "",
    port: member(tree, "proxy.port"),
    placeholderAuthorization: textOf(tree, "proxy.placeholderAuthorization"),
    profile: profileOf(tree),
    loginCommand: textOf(tree, "routing.loginCommand") ?? "",
    settingsFile: join(await paths.config({}), SETTINGS_FILE_NAME),
    record: tree,
  };
}
