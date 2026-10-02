import { mkdirSync } from "node:fs";
import { join } from "node:path";
import minecraftData from "minecraft-data";
import mineflayer, { type Bot } from "mineflayer";
import { plugin as collectblock } from "mineflayer-collectblock";
import { goals, Movements, pathfinder } from "mineflayer-pathfinder";
import { plugin as pvp } from "mineflayer-pvp";
import { plugin as tool } from "mineflayer-tool";
import { Vec3 } from "vec3";
import { McjsError } from "../errors.ts";
import type { BotConfig, ExecInput } from "../protocol.ts";
import { EventBuffer } from "./events.ts";
import { abortableSleep, executeCode } from "./execute.ts";
import { type Job, JobQueue } from "./jobs.ts";
import { type JsonValue, serialize } from "./serialize.ts";
import { SharedStore } from "./state.ts";

export class BotSession {
  bot: Bot;
  state = "connecting";
  generation: number;
  botState: Record<string, JsonValue> = Object.create(null);
  loadedPlugins: string[] = [];
  events: EventBuffer;
  queue: JobQueue;
  lastError: string | null = null;
  authPrompt: { uri: string; code: string } | null = null;
  private spawnTimer: ReturnType<typeof setTimeout>;
  private retiredQueues: JobQueue[] = [];
  constructor(
    public config: BotConfig,
    daemonId: string,
    authDir: string,
    private shared: SharedStore,
    generation = 1,
  ) {
    this.generation = generation;
    this.events = new EventBuffer(daemonId, config.id);
    const accountDir = join(
      authDir,
      new Bun.CryptoHasher("sha256").update(config.username).digest("hex"),
    );
    mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    this.queue = this.makeQueue();
    this.bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
      ...(config.version ? { version: config.version } : {}),
      profilesFolder: accountDir,
      onMsaCode: (data) => {
        this.state = "auth_required";
        this.authPrompt = { uri: data.verification_uri, code: data.user_code };
        this.emit("auth_required", {
          message: "Complete Microsoft login using bot info",
        });
        this.spawnTimer.refresh();
      },
    });
    this.spawnTimer = setTimeout(
      () => {
        if (this.state !== "ready") {
          this.lastError = "Connection/authentication deadline exceeded";
          this.state = "failed";
          this.queue.interrupt(this.lastError);
          this.bot.end(this.lastError);
        }
      },
      config.auth === "microsoft" ? 300_000 : 30_000,
    );
    this.bot.on("error", (error) => {
      this.lastError = error.message;
      this.emit("error", { message: error.message, trust: "untrusted" });
    });
    this.bot.on("kicked", (reason) =>
      this.emit("kicked", {
        text: String(reason).slice(0, 8000),
        trust: "untrusted",
      }),
    );
    this.bot.on("end", (reason) => {
      clearTimeout(this.spawnTimer);
      if (this.state !== "removed" && this.state !== "failed")
        this.state = "disconnected";
      this.queue.interrupt("Minecraft connection ended");
      this.emit("disconnected", {
        reason: String(reason).slice(0, 8000),
        trust: "untrusted",
      });
    });
    const requested = new Set(config.plugins);
    if (requested.has("collectblock")) {
      requested.add("pathfinder");
      requested.add("tool");
    }
    if (requested.has("pvp")) requested.add("pathfinder");
    for (const [id, plugin] of [
      ["pathfinder", pathfinder],
      ["tool", tool],
      ["collectblock", collectblock],
      ["pvp", pvp],
    ] as const) {
      if (requested.has(id)) {
        this.bot.loadPlugin(plugin);
        this.loadedPlugins.push(id);
      }
    }
    let spawned = false;
    this.bot.on("spawn", async () => {
      clearTimeout(this.spawnTimer);
      if (spawned) {
        this.state = "respawning";
        this.queue.interrupt("World changed or bot respawned");
        while (this.queue.busy) await Bun.sleep(10);
        if (
          this.state === "quarantined" ||
          this.state === "removed" ||
          this.state === "disconnected"
        )
          return;
        this.rotateQueue("World changed or bot respawned");
      }
      spawned = true;
      if (this.bot.pathfinder) {
        const movements = new Movements(this.bot);
        movements.canDig = false;
        movements.allow1by1towers = false;
        this.bot.pathfinder.setMovements(movements);
      }
      this.state = "ready";
      this.authPrompt = null;
      this.emit("ready", { version: this.bot.version });
    });
    this.bot.on("death", () => {
      this.queue.interrupt("Bot died");
      this.state = "respawning";
      this.emit("death", {});
    });
    this.bot.on("respawn", () => {
      if (spawned) {
        this.queue.interrupt("Dimension or world changed");
        this.state = "respawning";
      }
    });
    this.bot.on("health", () =>
      this.emit("health", { health: this.bot.health, food: this.bot.food }),
    );
    this.bot.on("messagestr", (text, position) =>
      this.emit("chat", {
        text: text.slice(0, 8000),
        position,
        trust: "untrusted",
      }),
    );
    this.emit("connecting", { host: config.host, port: config.port });
  }
  private emit(type: string, data: unknown) {
    this.events.push(type, data, this.generation);
  }
  private rotateQueue(reason: string) {
    this.queue.interrupt(reason);
    this.retiredQueues.push(this.queue);
    this.generation++;
    this.queue = this.makeQueue();
  }
  private makeQueue() {
    const generation = this.generation;
    return new JobQueue(this.config.id, generation, {
      execute: (input, signal, log, jobId) =>
        this.execute(input, signal, log, jobId),
      cleanup: (jobId) => {
        this.shared.releaseOwner(jobId);
        if (generation === this.generation) this.stopControls();
      },
      quarantine: () => {
        if (generation === this.generation) this.state = "quarantined";
      },
      changed: (job) =>
        this.events?.push("job", { id: job.id, state: job.state }, generation),
    });
  }
  submit(input: ExecInput) {
    if (this.state !== "ready")
      throw new McjsError("BOT_NOT_READY", `${this.config.id}: ${this.state}`);
    return this.queue.submit(input);
  }
  listJobs() {
    return [...this.retiredQueues, this.queue].flatMap((q) => q.list());
  }
  jobQueue(id: string) {
    const queue = [...this.retiredQueues, this.queue].find((q) =>
      q.list().some((j) => j.id === id),
    );
    if (!queue) throw new McjsError("JOB_NOT_FOUND", id);
    return queue;
  }
  info() {
    return {
      id: this.config.id,
      username: this.bot.username ?? this.config.username,
      host: this.config.host,
      port: this.config.port,
      state: this.state,
      version: this.bot.version ?? null,
      generation: this.generation,
      plugins: this.loadedPlugins,
      busy: this.queue.busy,
      lastError: this.lastError,
      authPrompt: this.authPrompt,
    };
  }
  snapshot() {
    return serialize({
      ...this.info(),
      position: this.bot.entity?.position ?? null,
      dimension: this.bot.game?.dimension ?? null,
      health: this.bot.health ?? null,
      food: this.bot.food ?? null,
      inventory:
        this.bot.inventory
          ?.items()
          .map((i) => ({ name: i.name, count: i.count, slot: i.slot })) ?? [],
      entities: Object.values(this.bot.entities ?? {})
        .filter(
          (e) =>
            this.bot.entity &&
            e.position.distanceTo(this.bot.entity.position) <= 32,
        )
        .slice(0, 32)
        .map((e) => ({
          id: e.id,
          name: e.name ?? e.username ?? null,
          position: e.position,
        })),
    });
  }
  stopControls() {
    // Cleanup must remain best effort even after a disconnect or partial login.
    const safely = (action: () => unknown) => {
      try {
        Promise.resolve(action()).catch(() => {});
      } catch {}
    };
    safely(() => this.bot.pathfinder?.setGoal(null));
    safely(() => this.bot.collectBlock?.cancelTask());
    safely(() => this.bot.pvp?.stop());
    safely(() => this.bot.clearControlStates());
    safely(() => this.bot.stopDigging());
    safely(() => this.bot.deactivateItem());
    safely(() => {
      if (this.bot.currentWindow) this.bot.closeWindow(this.bot.currentWindow);
    });
  }
  stop() {
    for (const job of this.queue.list())
      if (job.state === "running" || job.state === "queued")
        this.queue.cancel(job.id);
    this.stopControls();
    return this.info();
  }
  remove() {
    clearTimeout(this.spawnTimer);
    this.state = "removed";
    this.queue.interrupt("Bot removed");
    this.stopControls();
    this.bot.end("mcjs bot removed");
    return { id: this.config.id, removed: true };
  }
  private async execute(
    input: ExecInput,
    signal: AbortSignal,
    log: (...values: unknown[]) => void,
    jobId: string,
  ) {
    signal.throwIfAborted();
    const checkpoint = () => signal.throwIfAborted();
    const helpers = {
      snapshot: () => this.snapshot(),
      checkpoint,
      sleep: (ms: number) => abortableSleep(ms, signal),
      goto: async (goal: goals.Goal) => {
        checkpoint();
        if (!this.bot.pathfinder)
          throw new McjsError("PLUGIN_MISSING", "pathfinder");
        await this.bot.pathfinder.goto(goal);
        checkpoint();
      },
      collect: async (
        target: Parameters<Bot["collectBlock"]["collect"]>[0],
      ) => {
        checkpoint();
        if (!this.bot.collectBlock)
          throw new McjsError("PLUGIN_MISSING", "collectblock");
        await this.bot.collectBlock.collect(target);
        checkpoint();
      },
    };
    const shared = {
      get: this.shared.get.bind(this.shared),
      set: this.shared.set.bind(this.shared),
      delete: this.shared.delete.bind(this.shared),
      claim: (key: string, options: { ttlMs: number }) =>
        this.shared.claim(key, { ...options, owner: jobId }),
      renew: this.shared.renew.bind(this.shared),
      release: this.shared.release.bind(this.shared),
    };
    const result = await executeCode(
      input.code,
      input.lang,
      {
        bot: this.bot,
        mcData: minecraftData(this.bot.version),
        Vec3,
        goals,
        Movements,
        botState: this.botState,
        shared,
        signal,
        helpers,
        log,
        console: { log, info: log, warn: log, error: log, debug: log },
      },
      jobId,
    );
    serialize(this.botState);
    return result;
  }
}

export class BotManager {
  readonly shared = new SharedStore();
  readonly sessions = new Map<string, BotSession>();
  private retired: BotSession[] = [];
  constructor(
    private daemonId: string,
    private authDir: string,
  ) {}
  get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new McjsError("BOT_NOT_FOUND", id);
    return session;
  }
  create(config: BotConfig) {
    if (this.sessions.has(config.id))
      throw new McjsError("BOT_EXISTS", config.id);
    if (
      config.auth === "microsoft" &&
      [...this.sessions.values()].some(
        (s) =>
          s.config.auth === "microsoft" &&
          s.config.username.toLowerCase() === config.username.toLowerCase(),
      )
    )
      throw new McjsError(
        "ACCOUNT_IN_USE",
        "Use a separate entitled account for each online bot",
      );
    const session = new BotSession(
      config,
      this.daemonId,
      this.authDir,
      this.shared,
    );
    this.sessions.set(config.id, session);
    return session.info();
  }
  remove(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.remove();
      this.retired.push(session);
      this.sessions.delete(id);
    }
    return { id, removed: true };
  }
  reconnect(id: string) {
    const old = this.get(id);
    const state = old.botState;
    this.remove(id);
    const session = new BotSession(
      old.config,
      this.daemonId,
      this.authDir,
      this.shared,
      old.generation + 1,
    );
    session.botState = state;
    this.sessions.set(id, session);
    return session.info();
  }
  jobs(): Job[] {
    return [...this.retired, ...this.sessions.values()].flatMap((s) =>
      s.listJobs(),
    );
  }
  jobQueue(id: string) {
    const session = [...this.retired, ...this.sessions.values()].find((s) =>
      s.listJobs().some((j) => j.id === id),
    );
    if (!session) throw new McjsError("JOB_NOT_FOUND", id);
    return session.jobQueue(id);
  }
  stop() {
    for (const id of this.sessions.keys()) this.remove(id);
  }
}
