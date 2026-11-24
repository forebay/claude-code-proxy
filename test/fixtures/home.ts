import { join, resolve } from "node:path";
import { bundlePlugin } from "@weivel/typescript/bundle";
import { scratchHome, type PlacedLibrary, type ScratchFile } from "@weivel/typescript/testing";

export const REPOSITORY = resolve(import.meta.dirname, "..", "..");
export const HOST_ID = "test-host";

const NATIVE = join(REPOSITORY, "native");

/** One plugin to install: its manifest, the bundled entry to place where the manifest names it, and its stored settings. */
export interface Install {
  readonly manifest: { readonly id: string; readonly version: string; readonly entry: string } & Record<string, unknown>;
  readonly bundle: string;
  readonly settings: Record<string, unknown>;
}

export interface Home {
  readonly base: string;
  readonly runtime: string;
  /** Puts the process's places back as they were and deletes the home. */
  remove(): void;
}

function places(base: string): Record<string, string> {
  return {
    SPISOR_HOME: join(base, "portable"),
    SPISOR_STATE: join(base, "state"),
    SPISOR_CACHE: join(base, "cache"),
    SPISOR_SECRETS: join(base, "secrets"),
    HOME: join(base, "user"),
    USERPROFILE: join(base, "user"),
  };
}

function installFiles(base: string, install: Install): ScratchFile[] {
  const { id, version, entry } = install.manifest;
  const bundle = join(base, "cache", "bundles", id, version);
  return [
    { path: join(bundle, "plugin.json"), content: install.manifest },
    { path: join(bundle, entry), copyFrom: install.bundle },
    { path: join(bundle, ".installed.json"), content: { files: {} } },
    { path: join(base, "application", "config", `${id}.json`), content: install.settings },
  ];
}

function homeFiles(base: string, libraries: Readonly<Record<string, PlacedLibrary>>, installs: readonly Install[]): ScratchFile[] {
  const enabled = Object.fromEntries(installs.map((install) => [install.manifest.id, { enabled: true }]));
  const catalog = join(base, "catalog", "index.json");
  return [
    { path: catalog, content: { format: 1, items: {} } },
    { path: join(base, "state", "hosts", `${HOST_ID}.json`), content: { id: HOST_ID, kind: "host", version: "1.0.0", home: join(base, "application") } },
    { path: join(base, "state", "processes", `${HOST_ID}.json`), content: { pid: null, holders: [process.pid] } },
    {
      path: join(base, "cache", "hosts", "javascript-host.json"),
      content: {
        host: "2.0.0",
        libraries: {
          runtime: { version: "0.2.0", ...libraries.runtime },
          koffi: { version: "2.0.0", directory: join(base, "koffi") },
          "forebay-library": { version: "0.2.0", ...libraries.forebay_library },
        },
      },
    },
    ...installs.flatMap((install) => installFiles(base, install)),
    { path: join(base, "application", "config", "settings.json"), content: { plugins: enabled, catalog: { sources: [{ kind: "local", path: catalog }] } } },
  ];
}

/**
 * Lays out a fresh home under the temporary directory, as an install leaves one: the registered loader `test-host`,
 * the javascript-host's hint naming runtime and forebay-library, every install enabled, and this process recorded as
 * the loader's holder, so a SERVE run keeps running. The process's places point into it until `remove`.
 */
export function homeWith(installs: readonly Install[]): Home {
  const home = scratchHome({
    prefix: "ccp-home-",
    libraries: { runtime: join(NATIVE, "runtime"), forebay_library: join(NATIVE, "forebay_library") },
    environment: places,
    files: (base, libraries) => homeFiles(base, libraries, installs),
  });
  return { base: home.base, runtime: home.libraries.runtime!.binary, remove: home.remove };
}

/** Bundles a plugin entry into one module, as a plugin's build does, under `directory`. */
export function bundled(entry: string, directory: string): Promise<string> {
  return bundlePlugin(entry, directory);
}
