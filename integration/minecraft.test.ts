import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botConfigSchema, execSchema } from "../src/protocol.ts";
import { BotManager } from "../src/runtime/bots.ts";
import { isTerminal } from "../src/runtime/jobs.ts";

const directory = mkdtempSync(join(tmpdir(), "mcjs-minecraft-"));
const manager = new BotManager("integration", directory);
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
  for (const id of ["scout", "builder"])
    manager.create(
      botConfigSchema.parse({
        id,
        host: process.env.MCJS_TEST_HOST ?? "127.0.0.1",
        port,
        version,
        username: `mcjs_${id}`,
        auth: "offline",
      }),
    );
  await until(() =>
    [...manager.sessions.values()].every((s) => s.state === "ready"),
  );
}, 30_000);
afterAll(async () => {
  manager.stop();
  fixture?.kill();
  if (fixture) await fixture.exited;
  rmSync(directory, { recursive: true, force: true });
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

test("two Mineflayer bots join the server under Bun with default plugins", () => {
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
