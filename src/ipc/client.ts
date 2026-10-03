import { closeSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { McjsError } from "../errors.ts";
import { packageRoot } from "../package-root.ts";
import { type Envelope, PROTOCOL } from "../protocol.ts";
import { privateDirectory, type RuntimePaths } from "./paths.ts";

export class Client {
  constructor(readonly paths: RuntimePaths) {}
  async rpc<T = unknown>(
    method: string,
    params: unknown = {},
    requestId = crypto.randomUUID(),
  ): Promise<Envelope<T>> {
    let response: Response;
    try {
      const token = await Bun.file(this.paths.token).text();
      response = await fetch("http://localhost/v1/rpc", {
        unix: this.paths.socket,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: PROTOCOL,
          requestId,
          method,
          params,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new McjsError(
        "DAEMON_UNAVAILABLE",
        "Cannot reach daemon. Run mcjs daemon start. Do not automatically resubmit code after a lost response.",
      );
    }
    const envelope = (await response.json()) as Envelope<T>;
    if (envelope.protocolVersion !== PROTOCOL)
      throw new McjsError(
        "PROTOCOL_MISMATCH",
        "Restart daemon using the current mcjs version",
      );
    if (!envelope.ok)
      throw new McjsError(
        envelope.error?.code ?? "REMOTE_ERROR",
        envelope.error?.message ?? "Unknown daemon error",
        envelope.error?.retryable,
      );
    return envelope;
  }
  async start(profile: string) {
    try {
      return await this.rpc("status");
    } catch (error) {
      if (!(error instanceof McjsError) || error.code !== "DAEMON_UNAVAILABLE")
        throw error;
    }
    privateDirectory(this.paths.directory);
    privateDirectory(dirname(this.paths.log));
    let lock: number;
    try {
      lock = openSync(this.paths.lock, "wx", 0o600);
    } catch {
      for (let n = 0; n < 50; n++) {
        await Bun.sleep(100);
        try {
          return await this.rpc("status");
        } catch {}
      }
      throw new McjsError(
        "START_LOCKED",
        `Another start is in progress, or lock is stale: ${this.paths.lock}`,
      );
    }
    try {
      try {
        return await this.rpc("status");
      } catch {}
      // Refuse unknown/stale sockets; removal requires a verified dead daemon.
      let socketExists = false;
      try {
        lstatSync(this.paths.socket);
        socketExists = true;
      } catch {}
      if (socketExists)
        throw new McjsError(
          "STALE_SOCKET",
          `Unresponsive socket exists: ${this.paths.socket}. Verify the recorded PID is dead before removing it.`,
        );
      const logFd = openSync(this.paths.log, "a", 0o600);
      const child = Bun.spawn(
        [
          process.execPath,
          Bun.isStandaloneExecutable
            ? "__mcjs_daemon"
            : join(packageRoot, "src", "daemon", "main.ts"),
          profile,
          this.paths.socket,
        ],
        {
          stdin: "ignore",
          stdout: logFd,
          stderr: logFd,
          env: process.env,
        },
      );
      closeSync(logFd);
      child.unref();
      for (let n = 0; n < 100; n++) {
        if (child.exitCode !== null)
          throw new McjsError(
            "START_FAILED",
            `Daemon exited; see ${this.paths.log}`,
          );
        await Bun.sleep(100);
        try {
          return await this.rpc("status");
        } catch {}
      }
      throw new McjsError(
        "START_TIMEOUT",
        `Daemon did not become ready; see ${this.paths.log}`,
      );
    } finally {
      closeSync(lock);
      unlinkSync(this.paths.lock);
    }
  }
}
