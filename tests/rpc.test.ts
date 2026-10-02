import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/daemon/server.ts";
import { runtimePaths } from "../src/ipc/paths.ts";

const directory = mkdtempSync(join(tmpdir(), "mcjs-rpc-"));
const paths = {
  ...runtimePaths("test", join(directory, "d.sock")),
  auth: join(directory, "auth"),
};
let daemon: Awaited<ReturnType<typeof startServer>>;
let endpoint: URL;
beforeAll(async () => {
  daemon = await startServer(paths, (handler) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: handler,
    });
    endpoint = server.url;
    return server;
  });
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(directory, { recursive: true, force: true });
});

async function rpc(
  method: string,
  params = {},
  requestId = crypto.randomUUID(),
) {
  const token = await Bun.file(paths.token).text();
  return await (
    await fetch(new URL("/v1/rpc", endpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: 1, requestId, method, params }),
    })
  ).json();
}

test("the production RPC handler authenticates and reports Bun version", async () => {
  expect((await rpc("status")).data.bun).toBe(Bun.version);
  const response = await fetch(new URL("/v1/status", endpoint));
  expect((await response.json()).error.code).toBe("UNAUTHORIZED");
});
test("RPC validates params and deduplicates mutations over real HTTP", async () => {
  expect((await rpc("bot.create", { id: "../bad" })).error.code).toBe(
    "INVALID_ARGUMENT",
  );
  const id = crypto.randomUUID();
  const input = { key: "work", value: 42, expectedRevision: 0 };
  const first = await rpc("shared.set", input, id);
  expect((await rpc("shared.set", input, id)).data).toEqual(first.data);
  expect(
    (await rpc("shared.set", { ...input, value: 99 }, id)).error.code,
  ).toBe("REQUEST_ID_CONFLICT");
  expect((await rpc("shared.get", { key: "work" })).data).toEqual({
    value: 42,
    revision: 1,
  });
});
