import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { privateDirectory, type RuntimePaths } from "./ipc/paths.ts";
import { packageRoot } from "./package-root.ts";

export async function skillDirectory(paths: RuntimePaths) {
  if (!Bun.isStandaloneExecutable) return join(packageRoot, "skills", "mcjs");

  // Other programs cannot read Bun's virtual filesystem. Materialize the complete
  // skill, including its relative references, only when a real path is requested.
  const prefix = "skills/mcjs/";
  const files = Bun.embeddedFiles
    .filter(
      (file): file is Blob & { name: string } =>
        "name" in file &&
        typeof file.name === "string" &&
        file.name.startsWith(prefix),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length)
    throw new Error("The executable is missing its bundled skill");
  const hash = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update(await file.arrayBuffer());
  }
  const cache = join(dirname(paths.log), "skills");
  privateDirectory(dirname(paths.log));
  privateDirectory(cache);
  const destination = join(cache, hash.digest("hex"));
  if (!existsSync(destination)) {
    const temporary = mkdtempSync(join(cache, ".extract-"));
    try {
      for (const file of files) {
        const target = join(temporary, file.name.slice(prefix.length));
        mkdirSync(dirname(target), { recursive: true });
        await Bun.write(target, file);
      }
      try {
        renameSync(temporary, destination);
      } catch (error) {
        // Another CLI may have finished extracting these same content-addressed files.
        if (!existsSync(destination)) throw error;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return destination;
}
