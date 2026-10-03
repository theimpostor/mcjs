import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../src/ipc/client.ts";
import { runtimePaths } from "../src/ipc/paths.ts";

for (const slowRequest of [false, true])
  test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
    `RPC shutdown flushes its receipt and exits with live handles (slow request: ${slowRequest})`,
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "mcjs-stop-"));
      const socket = join(directory, "d.sock");
      const preload = join(directory, "interval.ts");
      // Submitted trusted JavaScript can create the same process-owned interval.
      await Bun.write(preload, "setInterval(() => {}, 1000);\n");
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          resolve("src/daemon/main.ts"),
          "test",
          socket,
        ],
        {
          env: { ...process.env, MCJS_STATE_DIR: join(directory, "state") },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const stderr = new Response(child.stderr).text();
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 4_000);
      let heldConnection: Socket | undefined;
      try {
        const paths = runtimePaths("test", socket);
        const client = new Client(paths);
        let ready = false;
        for (let i = 0; i < 100 && child.exitCode === null; i++) {
          try {
            await client.rpc("status");
            ready = true;
            break;
          } catch {}
          await Bun.sleep(20);
        }
        expect(ready).toBe(true);
        if (slowRequest) {
          const token = await Bun.file(paths.token).text();
          heldConnection = connect(socket);
          await new Promise<void>((resolve, reject) => {
            heldConnection?.once("connect", resolve);
            heldConnection?.once("error", reject);
          });
          heldConnection.write(
            `POST /v1/rpc HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n{`,
          );
          await Bun.sleep(20);
        }
        expect((await client.rpc("daemon.stop")).data).toEqual({
          stopping: true,
        });
        expect(await child.exited).toBe(0);
        expect(await stderr).toBe("");
        for (const path of [paths.socket, paths.token, paths.metadata])
          expect(existsSync(path)).toBe(false);
      } finally {
        clearTimeout(watchdog);
        heldConnection?.destroy();
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
