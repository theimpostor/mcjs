import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/daemon/server.ts";
import { Client } from "../src/ipc/client.ts";
import { runtimePaths } from "../src/ipc/paths.ts";
import { PROTOCOL } from "../src/protocol.ts";

const directory = mkdtempSync(join(tmpdir(), "mcjs-ipc-"));
const paths = {
  ...runtimePaths("test", join(directory, "d.sock")),
  auth: join(directory, "auth"),
  log: join(directory, "log"),
};
let daemon: Awaited<ReturnType<typeof startServer>>;
let client: Client;
beforeAll(async () => {
  if (process.env.MCJS_SKIP_UNIX === "1") return;
  daemon = await startServer(paths);
  client = new Client(paths);
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(directory, { recursive: true, force: true });
});

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "Bun Unix socket handshake and private file permissions",
  async () => {
    const response = await client.rpc<{ bun: string; protocolVersion: number }>(
      "status",
    );
    expect(response.data?.bun).toBe(Bun.version);
    expect(response.data?.protocolVersion).toBe(PROTOCOL);
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "daemon rejects unauthenticated requests",
  async () => {
    const response = await fetch("http://localhost/v1/status", {
      unix: paths.socket,
    });
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "malformed methods/parameters and duplicate mutation IDs are handled",
  async () => {
    await expect(client.rpc("bot.create", { id: "../bad" })).rejects.toThrow();
    await expect(client.rpc("unknown")).rejects.toThrow("unknown");
    const id = crypto.randomUUID();
    const request = { key: "test", value: 10, expectedRevision: 0 };
    const first = await client.rpc("shared.set", request, id);
    const second = await client.rpc("shared.set", request, id);
    expect(first.data).toEqual(second.data);
    await expect(
      client.rpc("shared.set", { ...request, value: 20 }, id),
    ).rejects.toThrow("different payload");
    expect((await client.rpc("shared.get", { key: "test" })).data).toEqual({
      value: 10,
      revision: 1,
    });
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "CLI connects as an independent process and stdout is one JSON envelope",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "daemon",
        "status",
        "--socket",
        paths.socket,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output).data.daemonId).toBe(daemon.status().daemonId);
    expect(output.trim().split("\n")).toHaveLength(1);
  },
);
