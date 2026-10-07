import { expect, spyOn, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mineflayer, { type Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { BotManager, BotSession } from "../src/runtime/bots.ts";
import { SharedStore } from "../src/runtime/state.ts";
import {
  type RunningViewer,
  startBotViewer,
  ViewerController,
} from "../src/runtime/viewer.ts";

let viewerAvailable = false;
try {
  createRequire(import.meta.url).resolve("prismarine-viewer/package.json");
  viewerAvailable = true;
} catch {}
const viewerTest = viewerAvailable ? test : test.skip;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function botFixture() {
  return Object.assign(new EventEmitter(), {
    version: "1.21.4",
    username: "ViewerTest",
    entity: { position: new Vec3(0, 64, 0), yaw: 0.25, pitch: -0.1 },
    entities: {},
    world: {
      getColumnAt: async (_pos: { x: number; z: number }) =>
        undefined as { toJson(): string } | undefined,
    },
  });
}
function running(port = 2345): RunningViewer & { closes: number } {
  return {
    info: {
      url: `http://127.0.0.1:${port}/`,
      port,
      firstPerson: false,
      viewDistance: 6,
      generation: 1,
    },
    closes: 0,
    async close() {
      this.closes++;
    },
  };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Viewer condition timed out");
    await Bun.sleep(5);
  }
}
async function connect(url: string) {
  const packets: unknown[][] = [];
  const socket = new WebSocket(
    `${url.replace("http:", "ws:")}socket.io/?EIO=4&transport=websocket`,
  );
  let connected = false;
  socket.onmessage = ({ data }) => {
    const message = String(data);
    if (message.startsWith("0")) socket.send("40");
    else if (message === "2") socket.send("3");
    else if (message.startsWith("40")) connected = true;
    else if (message.startsWith("42"))
      packets.push(JSON.parse(message.slice(2)));
  };
  try {
    await until(
      () => connected && packets.some(([event]) => event === "position"),
    );
    return { socket, packets };
  } catch (error) {
    socket.close();
    throw error;
  }
}

const defaults = { port: 0, firstPerson: false, viewDistance: 1 };

test("viewer controller closes a late start before stop completes, then can restart", async () => {
  const bot = botFixture() as unknown as Bot;
  const startup = deferred<RunningViewer>();
  let factories = 0;
  const next = running(3456);
  const controller = new ViewerController(
    () => ({ bot, generation: 1, ready: true }),
    async () => {
      factories++;
      return factories === 1 ? startup.promise : next;
    },
  );
  const starting = controller.start();
  const rejected = starting.catch((error: unknown) => error);
  await until(() => factories === 1);
  const stopping = controller.stop();
  expect(controller.info()).toBeNull();
  const late = running();
  startup.resolve(late);
  expect(await rejected).toMatchObject({ code: "VIEWER_INTERRUPTED" });
  await stopping;
  expect(late.closes).toBe(1);
  expect(await controller.start()).toEqual(next.info);
  await controller.stop();
  expect(next.closes).toBe(1);
});

test("concurrent viewer starts share one instance; changed options require explicit stop", async () => {
  const bot = botFixture() as unknown as Bot;
  let factories = 0;
  const viewer = running();
  const controller = new ViewerController(
    () => ({ bot, generation: 1, ready: true }),
    async () => {
      factories++;
      return viewer;
    },
  );
  const [first, second] = await Promise.all([
    controller.start(),
    controller.start(),
  ]);
  expect(first).toEqual(second);
  expect(factories).toBe(1);
  await expect(controller.start({ firstPerson: true })).rejects.toMatchObject({
    code: "VIEWER_ALREADY_RUNNING",
  });
  expect(controller.info()).toEqual(viewer.info);
  await Promise.all([controller.stop(), controller.stop()]);
  expect(viewer.closes).toBe(1);
});

test("viewer controller rejects stale generations and recovers after factory failures", async () => {
  const bot = botFixture() as unknown as Bot;
  const startup = deferred<RunningViewer>();
  let generation = 1;
  let called = false;
  const controller = new ViewerController(
    () => ({ bot, generation, ready: true }),
    async () => {
      called = true;
      return startup.promise;
    },
  );
  const starting = controller.start();
  const rejected = starting.catch((error: unknown) => error);
  await until(() => called);
  generation++;
  const stale = running();
  startup.resolve(stale);
  expect(await rejected).toMatchObject({ code: "VIEWER_INTERRUPTED" });
  expect(stale.closes).toBe(1);
  expect(controller.info()).toBeNull();
  const recovering = new ViewerController(
    () => ({ bot, generation, ready: true }),
    async () => {
      if (called) {
        called = false;
        throw new Error("missing optional package");
      }
      return running();
    },
  );
  await expect(recovering.start()).rejects.toThrow("missing optional package");
  expect((await recovering.start()).port).toBe(2345);
  await recovering.stop();
});

viewerTest(
  "viewer serves assets on loopback, sends initial position, rejects other origins, and detaches each tab",
  async () => {
    const bot = botFixture();
    const viewer = await startBotViewer(
      bot as unknown as Bot,
      { ...defaults, firstPerson: true },
      7,
    );
    let first: Awaited<ReturnType<typeof connect>> | undefined;
    let second: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      expect(viewer.info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(await (await fetch(viewer.info.url)).text()).toContain(
        "Prismarine Viewer",
      );
      expect(
        (
          await fetch(viewer.info.url, {
            headers: { origin: "https://example.com" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${viewer.info.url}socket.io/?EIO=4&transport=polling`, {
            headers: { origin: "https://example.com" },
          })
        ).status,
      ).toBe(403);
      first = await connect(viewer.info.url);
      second = await connect(viewer.info.url);
      expect(bot.listenerCount("move")).toBe(2);
      expect(
        first.packets.find(([event]) => event === "position")?.[1],
      ).toMatchObject({ pitch: -0.1, addMesh: false });
      // Mineflayer explicitly allows null oldBlock when the original block was unknown.
      expect(() =>
        bot.emit("blockUpdate", null, {
          position: new Vec3(1, 64, 1),
          stateId: 0,
        }),
      ).not.toThrow();
      await until(
        () =>
          first?.packets.some(([event]) => event === "blockUpdate") === true,
      );
      expect(
        first.packets.find(([event]) => event === "blockUpdate")?.[1],
      ).toMatchObject({ stateId: 0 });
      // Malformed browser events never reach WorldView's raycaster or bot controls.
      first.socket.send('42["mouseClick",null]');
      first.socket.send('42["eval","throw new Error()"]');
      await Bun.sleep(20);
      expect(first.socket.readyState).toBe(WebSocket.OPEN);
      first.socket.close();
      await until(() => bot.listenerCount("move") === 1);
    } finally {
      first?.socket.close();
      second?.socket.close();
      await viewer.close();
    }
    expect(bot.eventNames()).toEqual([]);
    expect(viewer.closed).toBe(true);
    const reuse = createServer();
    reuse.listen(viewer.info.port, "127.0.0.1");
    await once(reuse, "listening");
    reuse.close();
  },
);

viewerTest(
  "an occupied viewer port fails cleanly and the next start succeeds",
  async () => {
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const bot = botFixture() as unknown as Bot;
    try {
      await expect(
        startBotViewer(bot, { ...defaults, port: address.port }, 1),
      ).rejects.toMatchObject({ code: "VIEWER_START_FAILED" });
      expect(occupied.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
    const viewer = await startBotViewer(
      bot,
      { ...defaults, port: address.port },
      1,
    );
    await viewer.close();
  },
);

viewerTest(
  "unloaded and closed chunks cannot reappear after an outstanding world read",
  async () => {
    const bot = botFixture();
    const column = deferred<{ toJson(): string }>();
    let reading = false;
    bot.world.getColumnAt = async (pos) => {
      if (pos.x === 0 && pos.z === 0) {
        reading = true;
        return column.promise;
      }
      return undefined;
    };
    const viewer = await startBotViewer(bot as unknown as Bot, defaults, 1);
    const client = await connect(viewer.info.url);
    try {
      await until(() => reading);
      bot.emit("chunkColumnUnload", new Vec3(0, 0, 0));
      column.resolve({ toJson: () => "must not be emitted" });
      await Bun.sleep(30);
      expect(
        client.packets.filter(([event]) => event === "loadChunk"),
      ).toHaveLength(0);
    } finally {
      client.socket.close();
      await viewer.close();
    }
    expect(bot.eventNames()).toEqual([]);
  },
);

test("manager reserves a missing bot ID while remove is pending", async () => {
  const manager = new BotManager("test", "/unused");
  const remove = manager.remove("scout");
  expect(() =>
    manager.create({
      id: "scout",
      username: "Scout",
      host: "127.0.0.1",
      port: 25565,
      auth: "offline",
      plugins: [],
    }),
  ).toThrow("lifecycle change is in progress");
  await expect(manager.reconnect("scout")).rejects.toMatchObject({
    code: "BOT_BUSY",
  });
  await remove;
  await manager.stop();
  expect(() =>
    manager.create({
      id: "scout",
      username: "Scout",
      host: "127.0.0.1",
      port: 25565,
      auth: "offline",
      plugins: [],
    }),
  ).toThrow("shutting down");
});

viewerTest(
  "bot session invalidates viewers on death, dimension change, and disconnect",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "mcjs-viewer-session-"));
    const bot = Object.assign(botFixture(), {
      end() {
        bot.emit("end", "test ended");
      },
    });
    const createBot = spyOn(mineflayer, "createBot").mockReturnValue(
      bot as unknown as Bot,
    );
    let session: BotSession | undefined;
    try {
      session = new BotSession(
        {
          id: "scout",
          username: "Scout",
          host: "127.0.0.1",
          port: 25565,
          auth: "offline",
          plugins: [],
        },
        "test",
        directory,
        new SharedStore(),
      );
      createBot.mockRestore();
      bot.emit("spawn");
      const first = await session.startViewer(defaults);
      expect(first.generation).toBe(1);
      for (const event of ["death", "respawn"] as const) {
        bot.emit(event);
        expect(session.info().viewer).toBeNull();
        expect(session.state).toBe("respawning");
        await session.stopViewer();
        bot.emit("spawn");
        await until(() => session?.state === "ready");
        const next = await session.startViewer(defaults);
        expect(next.generation).toBe(session.generation);
      }
      bot.emit("end", "remote disconnect");
      expect(session.info().viewer).toBeNull();
      expect(session.state).toBe("disconnected");
      await expect(session.startViewer()).rejects.toMatchObject({
        code: "BOT_NOT_READY",
      });
      await session.stopViewer();
    } finally {
      createBot.mockRestore();
      await session?.remove();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("failed restart of an unexpectedly closed viewer never reports its old URL", async () => {
  const bot = botFixture() as unknown as Bot;
  const viewer = { ...running(), closed: false };
  let first = true;
  const controller = new ViewerController(
    () => ({ bot, generation: 1, ready: true }),
    async () => {
      if (!first) throw new Error("restart failed");
      first = false;
      return viewer;
    },
  );
  await controller.start();
  viewer.closed = true;
  expect(controller.info()).toBeNull();
  await expect(controller.start()).rejects.toThrow("restart failed");
  expect(controller.info()).toBeNull();
});
