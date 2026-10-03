import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled CLIs live in dist/; resolve symlinks so linked commands find the checkout.
export const packageRoot = Bun.isStandaloneExecutable
  ? dirname(dirname(realpathSync(process.execPath)))
  : fileURLToPath(new URL("../", import.meta.url));
