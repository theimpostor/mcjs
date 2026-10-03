import { fileURLToPath } from "node:url";

// Bun's embedded asset filesystem on our supported Unix platforms.
export const packageRoot = Bun.isStandaloneExecutable
  ? "/$bunfs/root"
  : fileURLToPath(new URL("../", import.meta.url));
