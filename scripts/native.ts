import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

interface NativeLibrary {
  readonly sibling: string;
  readonly target: string;
  readonly declaration: string;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SIBLINGS = join(REPOSITORY_ROOT, "siblings");
const NATIVE = join(REPOSITORY_ROOT, "native");
const LIBRARIES: readonly NativeLibrary[] = [
  { sibling: "forebay-library", target: "forebay_library", declaration: "library.json" },
  { sibling: "library", target: "runtime", declaration: join("runtime", "library.json") },
];

function sharedLibraryFileName(target: string): string {
  if (process.platform === "win32") return `${target}.dll`;
  return process.platform === "darwin" ? `lib${target}.dylib` : `lib${target}.so`;
}

function cmake(cmakeArguments: readonly string[]): void {
  execFileSync("cmake", cmakeArguments, { stdio: "inherit" });
}

function foundBelow(directory: string, fileName: string): string | undefined {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (entry === fileName && statSync(path).isFile()) return path;
    if (statSync(path).isDirectory()) {
      const found = foundBelow(path, fileName);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function built(library: NativeLibrary): void {
  const source = join(SIBLINGS, library.sibling);
  if (!existsSync(join(source, "CMakeLists.txt"))) throw new Error(`siblings/${library.sibling} is missing: check out what repo.json pins there`);
  const build = join(source, "build");
  cmake(["-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release"]);
  cmake(["--build", build, "--config", "Release", "--target", library.target]);
  const fileName = sharedLibraryFileName(library.target);
  const binary = foundBelow(join(build, "bin"), fileName);
  if (binary === undefined) throw new Error(`the build of ${library.sibling} left no ${fileName} under its bin`);
  const destination = join(NATIVE, library.target);
  mkdirSync(destination, { recursive: true });
  copyFileSync(binary, join(destination, fileName));
  copyFileSync(join(source, library.declaration), join(destination, "library.json"));
}

LIBRARIES.forEach(built);
