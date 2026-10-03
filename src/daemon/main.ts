import { runtimePaths } from "../ipc/paths.ts";
import { startServer } from "./server.ts";

const [profile = "default", socket] = process.argv.slice(2);
const daemon = await startServer(runtimePaths(profile, socket));
void daemon.stopped.then(() => process.exit(0));
const shutdown = () => void daemon.stop();
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
