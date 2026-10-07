import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/daemon/server.ts";
import { McjsError } from "../src/errors.ts";
import { runtimePaths } from "../src/ipc/paths.ts";
import {
  execSchema,
  MAX_JOB_RESPONSE_BYTES,
  MAX_RESULT_BYTES,
} from "../src/protocol.ts";
import { BotSession } from "../src/runtime/bots.ts";
import { isTerminal, JobQueue } from "../src/runtime/jobs.ts";
import type { JsonValue } from "../src/runtime/serialize.ts";

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

test("a rejected state replacement preserves the previous state", async () => {
  const session = Object.create(BotSession.prototype) as BotSession;
  session.botState = { previous: "preserved" };
  session.queue = new JobQueue("scout", 1, {
    execute: async () => null,
    cleanup() {},
    quarantine() {},
    changed() {},
  });
  const lookup = spyOn(daemon.bots, "get").mockReturnValue(session);
  try {
    let value: JsonValue = { leaf: 1 };
    for (let i = 0; i < 65; i++) value = { next: value };
    const rejected = await rpc("state.set", { id: "scout", value });
    expect(rejected.error.code).toBe("SERIALIZATION_ERROR");
    expect((await rpc("state.get", { id: "scout" })).data).toEqual({
      previous: "preserved",
    });
  } finally {
    lookup.mockRestore();
  }
});

test("viewer RPCs validate parameters before lookup and deduplicate retries", async () => {
  const session = Object.create(BotSession.prototype) as BotSession;
  const viewer = {
    url: "http://127.0.0.1:3007/",
    port: 3007,
    firstPerson: false,
    viewDistance: 6,
    generation: 1,
  };
  const started: unknown[] = [];
  let stops = 0;
  session.startViewer = async (options) => {
    started.push(options);
    return viewer;
  };
  session.stopViewer = async () => {
    stops++;
  };
  const lookup = spyOn(daemon.bots, "get").mockReturnValue(session);
  try {
    for (const params of [
      {},
      { id: "bad/id" },
      { id: "scout", port: -1 },
      { id: "scout", port: 65536 },
      { id: "scout", port: 1.5 },
      { id: "scout", firstPerson: "true" },
      { id: "scout", viewDistance: 0 },
      { id: "scout", viewDistance: 17 },
      { id: "scout", host: "0.0.0.0" },
    ])
      expect((await rpc("viewer.start", params)).error.code).toBe(
        "INVALID_ARGUMENT",
      );
    expect(
      (await rpc("viewer.stop", { id: "scout", port: 3007 })).error.code,
    ).toBe("INVALID_ARGUMENT");
    expect(lookup).not.toHaveBeenCalled();
    const startId = crypto.randomUUID();
    const first = await rpc("viewer.start", { id: "scout" }, startId);
    expect(first.data).toEqual(viewer);
    expect((await rpc("viewer.start", { id: "scout" }, startId)).data).toEqual(
      viewer,
    );
    expect(started).toEqual([
      { id: "scout", port: 0, firstPerson: false, viewDistance: 6 },
    ]);
    expect(
      (await rpc("viewer.start", { id: "scout", firstPerson: true }, startId))
        .error.code,
    ).toBe("REQUEST_ID_CONFLICT");
    const stopId = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await rpc("viewer.stop", { id: "scout" }, stopId)).data).toEqual({
        id: "scout",
        stopped: true,
      });
    expect(stops).toBe(1);
    for (const params of [
      { id: "scout", port: 0, firstPerson: true, viewDistance: 1 },
      { id: "scout", port: 65535, firstPerson: false, viewDistance: 16 },
    ]) {
      expect((await rpc("viewer.start", params)).ok).toBe(true);
      expect(started.at(-1)).toEqual(params);
    }
    session.startViewer = async () => {
      throw new McjsError("VIEWER_UNAVAILABLE", "Install prismarine-viewer");
    };
    expect((await rpc("viewer.start", { id: "scout" })).error).toEqual({
      code: "VIEWER_UNAVAILABLE",
      message: "Install prismarine-viewer",
      retryable: false,
    });
    expect((await rpc("status")).ok).toBe(true);
  } finally {
    lookup.mockRestore();
  }
});

test("job RPCs preserve allowed result and log sizes and result nesting", async () => {
  let returned: JsonValue = "x".repeat(MAX_RESULT_BYTES - 2);
  const queue = new JobQueue("scout", 1, {
    execute: async (_input, _signal, log) => {
      for (let i = 0; i < 4; i++) log("y".repeat(60_000));
      return returned;
    },
    cleanup() {},
    quarantine() {},
    changed() {},
  });
  const lookup = spyOn(daemon.bots, "jobQueue").mockReturnValue(queue);
  try {
    for (const deep of [false, true]) {
      if (deep) {
        returned = "leaf";
        for (let i = 0; i < 64; i++) returned = { next: returned };
      }
      const job = queue.submit(execSchema.parse({ botId: "scout", code: "0" }));
      while (!isTerminal(queue.get(job.id))) await Bun.sleep(1);
      expect(queue.get(job.id).state).toBe("succeeded");
      for (const method of ["job.get", "job.cancel"]) {
        const response = await rpc(method, { id: job.id });
        expect(response.ok).toBe(true);
        expect(response.data.result).toEqual(returned);
        expect(response.data.logs).toHaveLength(4);
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
          MAX_JOB_RESPONSE_BYTES,
        );
      }
    }
  } finally {
    lookup.mockRestore();
  }
});
