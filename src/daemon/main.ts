import { runtimePaths } from "../ipc/paths.ts";
import { startServer } from "./server.ts";

const [profile = "default", socket] = process.argv.slice(2);
const daemon = await startServer(runtimePaths(profile, socket));
const shutdown = async () => {
  await daemon.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
