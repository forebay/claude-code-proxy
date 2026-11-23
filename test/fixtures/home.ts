import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bundlePlugin } from "@weivel/typescript/bundle";

export const REPOSITORY = resolve(import.meta.dirname, "..", "..");
export const HOST_ID = "test-host";

const NATIVE = join(REPOSITORY, "native");
const PLACES = ["SPISOR_HOME", "SPISOR_STATE", "SPISOR_CACHE", "SPISOR_SECRETS", "HOME", "USERPROFILE"] as const;

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

function write(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

/** Copies a native library and its declaration out of `native/` into its own directory of the home. */
function placedLibrary(base: string, target: string): { directory: string; binary: string } {
  const source = join(NATIVE, target);
  const directory = join(base, "libraries", target);
  mkdirSync(directory, { recursive: true });
  for (const file of readdirSync(source)) copyFileSync(join(source, file), join(directory, file));
  const binary = readdirSync(source).find((file) => file !== "library.json");
  if (binary === undefined) throw new Error(`native/${target} holds no binary; run node scripts/native.ts`);
  return { directory, binary: join(directory, binary) };
}

function installed(base: string, install: Install): void {
  const { id, version, entry } = install.manifest;
  const bundle = join(base, "cache", "bundles", id, version);
  write(join(bundle, "plugin.json"), install.manifest);
  mkdirSync(dirname(join(bundle, entry)), { recursive: true });
  copyFileSync(install.bundle, join(bundle, entry));
  write(join(bundle, ".installed.json"), { files: {} });
  write(join(base, "application", "config", `${id}.json`), install.settings);
}

function placesOf(base: string): Record<(typeof PLACES)[number], string> {
  return {
    SPISOR_HOME: join(base, "portable"),
    SPISOR_STATE: join(base, "state"),
    SPISOR_CACHE: join(base, "cache"),
    SPISOR_SECRETS: join(base, "secrets"),
    HOME: join(base, "user"),
    USERPROFILE: join(base, "user"),
  };
}

/**
 * Lays out a fresh home under the temporary directory, as an install leaves one: the registered loader `test-host`,
 * the javascript-host's hint naming runtime and forebay-library, every install enabled, and this process recorded as
 * the loader's holder, so a SERVE run keeps running. The process's places point into it until `remove`.
 */
export function homeWith(installs: readonly Install[]): Home {
  const base = mkdtempSync(join(tmpdir(), "ccp-home-"));
  const runtime = placedLibrary(base, "runtime");
  const forebay = placedLibrary(base, "forebay_library");
  for (const directory of ["user", "portable", "secrets", "koffi"]) mkdirSync(join(base, directory), { recursive: true });
  write(join(base, "catalog", "index.json"), { format: 1, items: {} });
  write(join(base, "state", "hosts", `${HOST_ID}.json`), { id: HOST_ID, kind: "host", version: "1.0.0", home: join(base, "application") });
  write(join(base, "state", "processes", `${HOST_ID}.json`), { pid: null, holders: [process.pid] });
  write(join(base, "cache", "hosts", "javascript-host.json"), {
    host: "2.0.0",
    libraries: {
      runtime: { version: "0.2.0", ...runtime },
      koffi: { version: "2.0.0", directory: join(base, "koffi") },
      "forebay-library": { version: "0.2.0", ...forebay },
    },
  });
  installs.forEach((install) => installed(base, install));
  const enabled = Object.fromEntries(installs.map((install) => [install.manifest.id, { enabled: true }]));
  write(join(base, "application", "config", "settings.json"), { plugins: enabled, catalog: { sources: [{ kind: "local", path: join(base, "catalog", "index.json") }] } });
  const saved = PLACES.map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, placesOf(base));
  return {
    base,
    runtime: runtime.binary,
    remove() {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Bundles a plugin entry into one module, as a plugin's build does, under `directory`. */
export function bundled(entry: string, directory: string): Promise<string> {
  return bundlePlugin(entry, directory);
}

/** A port nothing listens on at the moment it is answered. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}
