import { runtimePaths } from "../ipc/paths.ts";
import { startServer } from "./server.ts";

export async function runDaemon(profile = "default", socket?: string) {
  const daemon = await startServer(runtimePaths(profile, socket));
  void daemon.stopped.then(() => process.exit(0));
  const shutdown = () => void daemon.stop();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) await runDaemon(...process.argv.slice(2));
