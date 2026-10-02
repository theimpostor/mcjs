import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { McjsError } from "../errors.ts";
import { idSchema } from "../protocol.ts";

export function runtimePaths(profile = "default", socketOverride?: string) {
  idSchema.parse(profile);
  const root =
    process.env.MCJS_RUNTIME_DIR ??
    process.env.XDG_RUNTIME_DIR ??
    join(tmpdir(), `mcjs-${process.getuid?.() ?? "user"}`);
  const directory = join(root, "mcjs", profile);
  const socket = socketOverride ?? join(directory, "daemon.sock");
  if (Buffer.byteLength(socket) > 100)
    throw new McjsError(
      "INVALID_ARGUMENT",
      "Socket path exceeds 100 bytes; set MCJS_RUNTIME_DIR to a shorter path",
    );
  const state = join(
    process.env.MCJS_STATE_DIR ??
      process.env.XDG_STATE_HOME ??
      join(homedir(), ".local", "state"),
    "mcjs",
    profile,
  );
  return {
    directory: dirname(socket),
    socket,
    token: `${socket}.token`,
    lock: `${socket}.lock`,
    metadata: `${socket}.json`,
    log: join(state, "daemon.log"),
    auth: join(state, "auth"),
  };
}
export type RuntimePaths = ReturnType<typeof runtimePaths>;

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new McjsError("UNSAFE_PATH", `Not an owned directory: ${path}`);
  chmodSync(path, 0o700);
}
