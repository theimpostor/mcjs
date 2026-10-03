import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { botConfigSchema, type Envelope, execSchema } from "../src/protocol.ts";
import { BotManager, type BotSession } from "../src/runtime/bots.ts";
import { isTerminal, type Job } from "../src/runtime/jobs.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "mcjs-minecraft-"));
const manager = new BotManager("integration", directory);
const disconnects: Promise<void>[] = [];
function trackDisconnect(session: BotSession) {
  disconnects.push(
    new Promise((resolve) => session.bot.once("end", () => resolve())),
  );
  return session;
}
let fixture: ReturnType<typeof Bun.spawn> | undefined;
let port = Number(process.env.MCJS_TEST_PORT ?? 0);
const version = process.env.MCJS_TEST_VERSION ?? "1.21.4";
async function until(check: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(
        `Timed out: ${JSON.stringify([...manager.sessions.values()].map((s) => s.info()))}`,
      );
    await Bun.sleep(50);
  }
}
beforeAll(async () => {
  if (process.env.MCJS_SKIP_UNIX !== "1") {
    const build = Bun.spawn([process.execPath, "run", "build"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const watchdog = setTimeout(() => build.kill("SIGKILL"), 60_000);
    try {
      const [stdout, stderr, status] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      if (status !== 0) throw new Error(`Build failed: ${stdout}\n${stderr}`);
    } finally {
      clearTimeout(watchdog);
      if (build.exitCode === null) build.kill("SIGKILL");
      await build.exited;
    }
  }
  if (!port) {
    const child = Bun.spawn([process.execPath, "integration/fixture.cjs"], {
      stdout: "pipe",
      stderr: "inherit",
    });
    fixture = child;
    const reader = child.stdout.getReader();
    let buffer = "";
    const deadline = setTimeout(() => child.kill(), 20_000);
    try {
      while (!port) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`Fixture exited: ${buffer}`);
        buffer += new TextDecoder().decode(value);
        const match = buffer.match(/\{"port":(\d+)\}/);
        if (match) port = Number(match[1]);
      }
    } finally {
      clearTimeout(deadline);
      reader.releaseLock();
    }
  }
  await Promise.all(["scout", "builder"].map((id) => create(id)));
}, 90_000);
afterAll(async () => {
  manager.stop();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(disconnects),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Bots did not disconnect during teardown")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    fixture?.kill();
    if (fixture) await fixture.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

async function run(id: string, code: string, timeoutMs = 10_000) {
  const session = manager.get(id);
  const job = session.submit(execSchema.parse({ botId: id, code, timeoutMs }));
  await until(
    () => isTerminal(session.jobQueue(job.id).get(job.id)),
    timeoutMs + 3000,
  );
  const result = session.jobQueue(job.id).get(job.id);
  if (result.state !== "succeeded") throw new Error(JSON.stringify(result));
  return result.result;
}

async function create(id: string, plugins?: string[]) {
  manager.create(
    botConfigSchema.parse({
      id,
      host: process.env.MCJS_TEST_HOST ?? "127.0.0.1",
      port,
      version,
      username: `mcjs_${id}`,
      ...(plugins ? { plugins } : {}),
    }),
  );
  const session = trackDisconnect(manager.get(id));
  await until(() => manager.get(id).state === "ready");
  return session;
}

test("two Mineflayer bots join with default offline auth and plugins", () => {
  for (const session of manager.sessions.values()) {
    expect(session.bot.version).toBe(version);
    expect(session.loadedPlugins).toEqual([
      "pathfinder",
      "tool",
      "collectblock",
    ]);
    expect(session.bot.entity.position.y).toBeGreaterThan(0);
  }
});
test("programs observe live inventory, preserve memory, coordinate and exchange chat", async () => {
  expect(
    await run(
      "scout",
      "botState.count = 7; shared.set('meeting', { x: 1 }, { expectedRevision: 0 }); bot.chat('mcjs integration hello'); return bot.inventory.items().map(i => i.name);",
    ),
  ).toBeArray();
  expect(await run("scout", "return botState.count")).toBe(7);
  expect(await run("builder", "return shared.get('meeting').value")).toEqual({
    x: 1,
  });
  await until(() =>
    manager
      .get("builder")
      .events.read()
      .events.some(
        (e) =>
          e.type === "chat" &&
          JSON.stringify(e.payload).includes("mcjs integration hello"),
      ),
  );
});
test("pathfinder moves a live bot and returns its final position", async () => {
  await until(() => manager.get("scout").bot.entity.onGround);
  const start = manager.get("scout").bot.entity.position.clone();
  await run(
    "scout",
    `await helpers.goto(new goals.GoalNear(${Math.floor(start.x) + 3}, ${Math.floor(start.y)}, ${Math.floor(start.z)}, 1)); return bot.entity.position;`,
  );
  expect(
    manager.get("scout").bot.entity.position.distanceTo(start),
  ).toBeGreaterThan(1);
}, 20_000);
test("background work cancels and disconnect interrupts work", async () => {
  const session = manager.get("builder");
  const job = session.submit(
    execSchema.parse({
      botId: "builder",
      code: "await helpers.sleep(10000); return true",
    }),
  );
  await until(() => session.queue.get(job.id).state === "running");
  session.queue.cancel(job.id);
  await until(() => isTerminal(session.queue.get(job.id)));
  expect(session.queue.get(job.id).state).toBe("canceled");
  const second = session.submit(
    execSchema.parse({ botId: "builder", code: "await helpers.sleep(10000)" }),
  );
  manager.remove("builder");
  await until(() => isTerminal(manager.jobQueue(second.id).get(second.id)));
  expect(manager.jobQueue(second.id).get(second.id).state).toBe("interrupted");
});

test("collection digs requested blocks and restores conservative navigation", async () => {
  const session = manager.get("scout");
  await until(() => session.bot.entity.onGround);
  const before = session.bot.pathfinder.movements;
  expect(before.canDig).toBe(false);
  expect(before.allow1by1towers).toBe(false);
  expect(
    await run(
      "scout",
      `const feet = bot.entity.position.floored();
       const target = bot.findBlock({
         matching: block => block && ['grass_block', 'dirt'].includes(block.name),
         useExtraInfo: block => block.position.y === feet.y - 1
           && block.position.distanceTo(feet) > 1.5,
         maxDistance: 6
       });
       if (!target) throw new Error('No nearby soil available for collection');
       const other = bot.findBlock({
         matching: block => block && ['grass_block', 'dirt'].includes(block.name),
         useExtraInfo: block => !block.position.equals(target.position),
         maxDistance: 6
       });
       if (!other) throw new Error('No second soil block available');
       const position = target.position.clone();
       const collection = helpers.collect(target);
       const allowed = bot.pathfinder.movements.safeToBreak(target);
       const unrelatedAllowed = bot.pathfinder.movements.safeToBreak(other);
       await collection;
       return { allowed, unrelatedAllowed,
         changed: bot.blockAt(position).type !== target.type };`,
    ),
  ).toEqual({ allowed: true, unrelatedAllowed: false, changed: true });
  expect(session.bot.pathfinder.movements).toBe(before);
  expect(before.canDig).toBe(false);
  expect(before.allow1by1towers).toBe(false);
  const position = session.bot.entity.position.floored();
  await run(
    "scout",
    `await helpers.goto(new goals.GoalNear(${position.x + 3}, ${position.y}, ${position.z}, 1));`,
  );
}, 30_000);

test("quarantine survives death and respawn lifecycle notifications", async () => {
  const session = await create("quarantine");
  try {
    const job = session.submit(
      execSchema.parse({
        botId: "quarantine",
        code: "await new Promise(() => {})",
        timeoutMs: 10,
      }),
    );
    await until(() => session.state === "quarantined");
    const generation = session.generation;
    // Drive lifecycle handlers on a real initialized bot. Flying Squid does
    // not supply a reliable current-protocol death/respawn fixture.
    session.bot.emit("death");
    session.bot.emit("respawn");
    session.bot.emit("spawn");
    await Bun.sleep(30);
    expect(session.state).toBe("quarantined");
    expect(session.generation).toBe(generation);
    expect(session.jobQueue(job.id).get(job.id).state).toBe("timed_out");
    expect(() =>
      session.submit(
        execSchema.parse({ botId: "quarantine", code: "return true" }),
      ),
    ).toThrow("quarantined");
  } finally {
    manager.remove("quarantine");
  }
}, 30_000);

test("quarantine reached while respawn waits cannot be cleared", async () => {
  const session = await create("waiting");
  try {
    session.submit(
      execSchema.parse({
        botId: "waiting",
        code: "botState.started = true; await new Promise(() => {})",
      }),
    );
    await until(() => session.botState.started === true);
    const generation = session.generation;
    session.bot.emit("respawn");
    session.bot.emit("spawn");
    await until(() => session.state === "quarantined");
    await Bun.sleep(30);
    expect(session.state).toBe("quarantined");
    expect(session.generation).toBe(generation);
  } finally {
    manager.remove("waiting");
  }
}, 30_000);

test("reconnect copies nested memory before retiring the previous session", async () => {
  const old = await create("memory");
  try {
    const job = old.submit(
      execSchema.parse({
        botId: "memory",
        code: `botState.nested = { value: 'saved' };
               await new Promise(resolve => bot.once('review_release', resolve));
               botState.nested.value = 'retired';
               botState.late = true;`,
      }),
    );
    await until(() => old.botState.nested !== undefined);
    manager.reconnect("memory");
    const current = trackDisconnect(manager.get("memory"));
    expect(current.botState).not.toBe(old.botState);
    expect(current.botState.nested).not.toBe(old.botState.nested);
    await until(() => current.state === "ready");
    (old.bot as unknown as EventEmitter).emit("review_release");
    await until(() => old.botState.late === true);
    expect(current.botState.nested).toEqual({ value: "saved" });
    expect(current.botState.late).toBeUndefined();
    await until(() => isTerminal(manager.jobQueue(job.id).get(job.id)));
    expect(manager.jobQueue(job.id).get(job.id).state).toBe("interrupted");
    expect(await run("memory", "return botState.nested.value")).toBe("saved");
  } finally {
    manager.remove("memory");
  }
}, 30_000);

test("invalid reconnect memory leaves the current session connected", async () => {
  const session = manager.get("scout");
  const invalid = session.botState as Record<string, unknown>;
  invalid.unsupported = () => {};
  try {
    expect(() => manager.reconnect("scout")).toThrow("Unsupported");
    expect(manager.get("scout")).toBe(session);
    expect(session.state).toBe("ready");
  } finally {
    delete invalid.unsupported;
  }
});

test("PVP cleanup allows the immediately following navigation job", async () => {
  const session = await create("combat", ["pathfinder", "pvp"]);
  try {
    await until(() => session.bot.entity.onGround);
    // Use an initialized entity without relying on nearby server mobs. The
    // target is cleared on return before any further attack can be scheduled.
    const combat = session.submit(
      execSchema.parse({
        botId: "combat",
        code: "await bot.pvp.attack(bot.entity); return true",
      }),
    );
    const position = session.bot.entity.position.floored();
    const navigate = session.submit(
      execSchema.parse({
        botId: "combat",
        code: `await helpers.goto(new goals.GoalNear(${position.x + 3}, ${position.y}, ${position.z}, 1)); return true`,
      }),
    );
    await until(() =>
      isTerminal(session.jobQueue(navigate.id).get(navigate.id)),
    );
    expect(session.jobQueue(combat.id).get(combat.id).state).toBe("succeeded");
    expect(session.jobQueue(navigate.id).get(navigate.id).state).toBe(
      "succeeded",
    );
    expect(session.bot.pvp.target).toBeUndefined();
    expect(session.bot.pathfinder.movements.canDig).toBe(false);
    expect(session.bot.pathfinder.movements.allow1by1towers).toBe(false);
  } finally {
    manager.remove("combat");
  }
}, 30_000);

test("job lookup avoids cloning histories across generations and removal", async () => {
  const session = await create("lookup");
  const job = session.submit(
    execSchema.parse({ botId: "lookup", code: "return 'retained'" }),
  );
  await until(() => isTerminal(session.jobQueue(job.id).get(job.id)));
  const queue = session.queue;
  const list = spyOn(queue, "list").mockImplementation(() => {
    throw new Error("Lookup cloned queue history");
  });
  const summaries = spyOn(session, "listJobs").mockImplementation(() => {
    throw new Error("Lookup enumerated session history");
  });
  try {
    expect(manager.jobQueue(job.id).get(job.id).result).toBe("retained");
    session.bot.emit("spawn");
    await until(() => session.generation === 2);
    expect(manager.jobQueue(job.id)).toBe(queue);
    manager.remove("lookup");
    expect(manager.jobQueue(job.id)).toBe(queue);
    expect(() => manager.jobQueue("missing-job")).toThrow("missing-job");
  } finally {
    list.mockRestore();
    summaries.mockRestore();
    manager.remove("lookup");
  }
}, 30_000);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "compiled CLI creates a live bot and runs JavaScript and TypeScript without Bun on PATH",
  async () => {
    const working = mkdtempSync(join(tmpdir(), "mcjs-c-"));
    const socket = join(working, "d.sock");
    const emptyPath = join(working, "empty-bin");
    mkdirSync(emptyPath);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: emptyPath,
      MCJS_STATE_DIR: join(working, "state"),
    };
    delete env.BUN_BE_BUN;
    let daemonPid: number | undefined;
    async function compiled<T>(...args: string[]) {
      const child = Bun.spawn(
        [
          join(root, "dist", "mcjs"),
          ...args,
          "--profile",
          "compiled",
          "--socket",
          socket,
        ],
        { cwd: working, env, stdout: "pipe", stderr: "pipe" },
      );
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 25_000);
      try {
        const [stdout, stderr, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (status !== 0)
          throw new Error(`Compiled CLI failed: ${stdout}\n${stderr}`);
        expect(stdout.trim().split("\n")).toHaveLength(1);
        const envelope = JSON.parse(stdout) as Envelope<T>;
        expect(envelope.ok).toBe(true);
        return envelope.data;
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    }
    try {
      const info = await compiled<{ state: string; plugins: string[] }>(
        "bot",
        "create",
        "compiled",
        "--username",
        "mcjs_compiled",
        "--auth",
        "offline",
        "--host",
        process.env.MCJS_TEST_HOST ?? "127.0.0.1",
        "--port",
        String(port),
        "--version",
        version,
        "--wait-ms",
        "20000",
      );
      expect(info?.state).toBe("ready");
      expect(info?.plugins).toEqual(["pathfinder", "tool", "collectblock"]);
      daemonPid = (await compiled<{ pid: number }>("daemon", "status"))?.pid;
      const js = await compiled<Job>(
        "exec",
        "compiled",
        "return bot.entity.position",
      );
      expect(js?.state).toBe("succeeded");
      expect(js?.result).toMatchObject({
        x: expect.any(Number),
        y: expect.any(Number),
        z: expect.any(Number),
      });
      const ts = await compiled<Job>(
        "exec",
        "compiled",
        "--lang",
        "ts",
        "const position: Vec3 = bot.entity.position; await helpers.sleep(10); return { position, snapshot: helpers.snapshot() };",
      );
      expect(ts?.state).toBe("succeeded");
      expect(ts?.result).toMatchObject({
        position: {
          x: expect.any(Number),
          y: expect.any(Number),
          z: expect.any(Number),
        },
        snapshot: {
          id: "compiled",
          state: "ready",
          inventory: expect.any(Array),
        },
      });
      expect(
        await compiled<{ id: string; removed: boolean }>(
          "bot",
          "remove",
          "compiled",
        ),
      ).toEqual({
        id: "compiled",
        removed: true,
      });
      expect(await compiled<{ stopping: boolean }>("daemon", "stop")).toEqual({
        stopping: true,
      });
      const deadline = Date.now() + 3_000;
      while (existsSync(socket) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(socket)).toBe(false);
    } finally {
      if (daemonPid === undefined && existsSync(`${socket}.json`)) {
        const metadata = await Bun.file(`${socket}.json`).json();
        daemonPid = metadata.pid;
      }
      if (daemonPid !== undefined) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {}
      }
      const deadline = Date.now() + 2_000;
      while (existsSync(socket) && Date.now() < deadline) await Bun.sleep(20);
      if (existsSync(socket) && daemonPid !== undefined) {
        try {
          process.kill(daemonPid, "SIGKILL");
        } catch {}
      }
      rmSync(working, { recursive: true, force: true });
    }
  },
  40_000,
);
