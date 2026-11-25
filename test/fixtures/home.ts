import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundlePlugin } from "@weivel/typescript/bundle";
import type { BoundDefinition } from "@weivel/typescript/host";
import { describedLibrary, scratchHome, setVariables, type DescribedLibrary, type PlacedLibrary } from "@weivel/typescript/testing";

export const REPOSITORY = resolve(import.meta.dirname, "..", "..");
export const HOST_ID = "test-host";

const NATIVE = join(REPOSITORY, "native");

/** One plugin to install: its manifest, the bundled entry to place where the manifest names it, and its stored settings. */
export interface Install {
  readonly manifest: { readonly id: string; readonly version: string; readonly entry: string } & Record<string, unknown>;
  readonly bundle: string;
  readonly settings: Record<string, unknown>;
}

/** Where runtime-testing placed one install: its version folder and the file its settings are read from. */
export interface PlacedInstall {
  readonly id: string;
  readonly bundle: string;
  readonly settings_file: string;
}

export interface Home {
  readonly base: string;
  readonly runtime: string;
  readonly installs: readonly PlacedInstall[];
  /** The folder the loader's processes record and its ready record are written in. */
  readonly processes: string;
  /** Puts the process's places back as they were and deletes the home. */
  remove(): void;
}

interface LaidOutHome {
  readonly variables: readonly { readonly name: string; readonly value: string }[];
  readonly processes: string;
  readonly installs: readonly PlacedInstall[];
}

let runtimeTesting: DescribedLibrary | undefined;

/** runtime-testing's service, the test-only C library that lays a home out through runtime's own writers, loaded once. */
function testingService(): BoundDefinition {
  runtimeTesting ??= describedLibrary(join(NATIVE, "runtime_testing"));
  return runtimeTesting.described.get("runtime.testing")!;
}

function hintedLibrary(id: string, placed: PlacedLibrary): Record<string, unknown> {
  return { id, version: null, directory: placed.directory, binary: placed.binary };
}

function layOutHome(base: string, libraries: Readonly<Record<string, PlacedLibrary>>, installs: readonly Install[]): Promise<LaidOutHome> {
  const argument = {
    base,
    host_id: HOST_ID,
    installs: installs.map((install) => ({ manifest: install.manifest, entry_source: install.bundle, settings: install.settings })),
    libraries: [hintedLibrary("runtime", libraries.runtime!), hintedLibrary("forebay-library", libraries.forebay_library!)],
    holder: process.pid,
  };
  return testingService().lay_out_home!({ argument }) as Promise<LaidOutHome>;
}

/**
 * Lays out a fresh home under the temporary directory through runtime-testing, as an install leaves one: the
 * registered loader `test-host`, the javascript-host's hint naming runtime and forebay-library, every install enabled,
 * and this process recorded as the loader's holder, so a SERVE run keeps running. The process's places point into it
 * until `remove`.
 */
export async function homeWith(installs: readonly Install[]): Promise<Home> {
  const scratch = scratchHome({
    prefix: "ccp-home-",
    libraries: { runtime: join(NATIVE, "runtime"), forebay_library: join(NATIVE, "forebay_library") },
    environment: () => ({}),
    files: () => [],
  });
  try {
    const base = join(scratch.base, "home");
    mkdirSync(base);
    const laidOut = await layOutHome(base, scratch.libraries, installs);
    const restore = setVariables(Object.fromEntries(laidOut.variables.map((variable) => [variable.name, variable.value])));
    const remove = (): void => {
      restore();
      scratch.remove();
    };
    return { base, runtime: scratch.libraries.runtime!.binary, installs: laidOut.installs, processes: laidOut.processes, remove };
  } catch (error) {
    scratch.remove();
    throw error;
  }
}

/** Bundles a plugin entry into one module, as a plugin's build does, under `directory`. */
export function bundled(entry: string, directory: string): Promise<string> {
  return bundlePlugin(entry, directory);
}
