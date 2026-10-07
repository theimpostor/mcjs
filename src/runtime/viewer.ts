import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Bot, BotEvents } from "mineflayer";
import { McjsError } from "../errors.ts";

export interface ViewerOptions {
  port?: number;
  firstPerson?: boolean;
  viewDistance?: number;
}
export interface ViewerInfo {
  url: string;
  port: number;
  firstPerson: boolean;
  viewDistance: number;
  generation: number;
}
export interface RunningViewer {
  readonly closed?: boolean;
  info: ViewerInfo;
  close(): Promise<void>;
}
interface ViewerContext {
  bot: Bot;
  generation: number;
  ready: boolean;
}
type ViewerFactory = (
  bot: Bot,
  options: Required<ViewerOptions>,
  generation: number,
) => Promise<RunningViewer>;

/** Serializes starts/stops; an invalidated start must close before it can settle. */
export class ViewerController {
  private running: RunningViewer | null = null;
  private visible: ViewerInfo | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  constructor(
    private context: () => ViewerContext,
    private factory: ViewerFactory = startBotViewer,
  ) {}
  info() {
    return this.running?.closed ? null : this.visible;
  }
  start(options: ViewerOptions = {}): Promise<ViewerInfo> {
    const requested = {
      port: options.port ?? 0,
      firstPerson: options.firstPerson ?? false,
      viewDistance: options.viewDistance ?? 6,
    };
    if (
      !Number.isInteger(requested.port) ||
      requested.port < 0 ||
      requested.port > 65535 ||
      !Number.isInteger(requested.viewDistance) ||
      requested.viewDistance < 1 ||
      requested.viewDistance > 16 ||
      typeof requested.firstPerson !== "boolean"
    )
      return Promise.reject(
        new McjsError("INVALID_ARGUMENT", "Invalid viewer options"),
      );
    const initial = this.context();
    if (!initial.ready)
      return Promise.reject(
        new McjsError("BOT_NOT_READY", "Viewer requires a ready bot"),
      );
    const epoch = this.epoch;
    const current = () => {
      const now = this.context();
      return (
        epoch === this.epoch &&
        now.ready &&
        now.bot === initial.bot &&
        now.generation === initial.generation
      );
    };
    const operation = this.pending.then(async () => {
      if (!current())
        throw new McjsError(
          "VIEWER_INTERRUPTED",
          "Bot or viewer lifecycle changed during startup",
        );
      if (this.running?.closed) {
        this.running = null;
        this.visible = null;
      }
      if (this.running) {
        const info = this.running.info;
        if (
          (requested.port === 0 || requested.port === info.port) &&
          requested.firstPerson === info.firstPerson &&
          requested.viewDistance === info.viewDistance
        )
          return info;
        throw new McjsError(
          "VIEWER_ALREADY_RUNNING",
          "Stop the existing viewer before changing its options",
        );
      }
      const viewer = await this.factory(
        initial.bot,
        requested,
        initial.generation,
      );
      if (!current()) {
        await viewer.close();
        throw new McjsError(
          "VIEWER_INTERRUPTED",
          "Bot or viewer lifecycle changed during startup",
        );
      }
      this.running = viewer;
      this.visible = viewer.info;
      return viewer.info;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  stop(): Promise<void> {
    this.epoch++;
    this.visible = null;
    const operation = this.pending.then(async () => {
      const viewer = this.running;
      this.running = null;
      await viewer?.close();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

type App = RequestListener;
type Vec3 = Bot["entity"]["position"];
interface ViewerSocket {
  emit(event: string, data: unknown): void;
  once(event: "disconnect", listener: () => void): void;
  disconnect(close: boolean): void;
}
interface SocketServer {
  on(event: "connection", listener: (socket: ViewerSocket) => void): void;
  close(): Promise<void>;
}
interface WorldView {
  lastPos: Vec3;
  loadedChunks: Record<string, boolean>;
  init(position: Vec3): Promise<void>;
  loadChunk(position: Vec3): Promise<void>;
  updatePosition(position: Vec3): Promise<void>;
  unloadChunk(position: Vec3): void;
}
interface ViewerDependencies {
  express: () => App;
  setupRoutes(app: App): void;
  SocketServer: new (
    http: Server,
    options: {
      serveClient: boolean;
      maxHttpBufferSize: number;
      allowRequest(
        request: IncomingMessage,
        callback: (error: string | null, allowed: boolean) => void,
      ): void;
    },
  ) => SocketServer;
  WorldView: new (
    world: Bot["world"],
    distance: number,
    position: Vec3,
    emitter: { emit(event: string, data: unknown): void; on(): void },
  ) => WorldView;
  publicDirectory: string;
  supportedVersions: string[];
}

function loadViewer(): ViewerDependencies {
  const candidates = [
    ...(process.env.MCJS_VIEWER_DIR
      ? [join(resolve(process.env.MCJS_VIEWER_DIR), "mcjs-viewer-loader.cjs")]
      : []),
    import.meta.url,
    join(dirname(process.execPath), "mcjs-viewer-loader.cjs"),
    join(process.cwd(), "mcjs-viewer-loader.cjs"),
  ];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const packagePath = createRequire(candidate).resolve(
        "prismarine-viewer/package.json",
      );
      const requireViewer = createRequire(packagePath);
      const publicDirectory = join(dirname(packagePath), "public");
      if (
        !existsSync(join(publicDirectory, "index.js")) ||
        !existsSync(join(publicDirectory, "worker.js"))
      )
        throw new Error("prismarine-viewer browser assets are missing");
      return {
        express: requireViewer("express"),
        setupRoutes: requireViewer("./lib/common.js").setupRoutes,
        SocketServer: requireViewer("socket.io").Server,
        WorldView: requireViewer("./viewer/lib/worldView.js").WorldView,
        supportedVersions: requireViewer("./viewer/lib/version.js")
          .supportedVersions,
        publicDirectory,
      };
    } catch (error) {
      failures.push(
        `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new McjsError(
    "VIEWER_UNAVAILABLE",
    `Install optional viewer dependencies with bun install, or install prismarine-viewer@1.33.0 in MCJS_VIEWER_DIR. ${failures.join("; ")}`,
  );
}

/** Uses upstream rendering/assets, with our own loopback server and no inbound bot actions. */
export async function startBotViewer(
  bot: Bot,
  options: Required<ViewerOptions>,
  generation: number,
): Promise<RunningViewer> {
  const dependencies = loadViewer();
  if (!dependencies.supportedVersions.includes(bot.version))
    throw new McjsError(
      "VIEWER_UNSUPPORTED_VERSION",
      `Installed viewer does not support Minecraft ${bot.version}; supported: ${dependencies.supportedVersions.join(", ")}`,
    );
  for (const asset of [
    `textures/${bot.version}.png`,
    `blocksStates/${bot.version}.json`,
  ])
    if (!existsSync(join(dependencies.publicDirectory, asset)))
      throw new McjsError(
        "VIEWER_UNAVAILABLE",
        `Installed viewer is missing browser asset ${asset}`,
      );
  const app = dependencies.express();
  dependencies.setupRoutes(app);
  let authority = "";
  let closed = false;
  const allowed = (host: string | undefined, origin: string | undefined) =>
    host === authority && (!origin || origin === `http://${authority}`);
  const http = createServer((request, response) => {
    if (!allowed(request.headers.host, request.headers.origin)) {
      response.writeHead(403).end("Viewer accepts only its loopback origin");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    app(request, response);
  });
  const io = new dependencies.SocketServer(http, {
    serveClient: false,
    maxHttpBufferSize: 16_384,
    allowRequest: (request, callback) =>
      callback(
        null,
        !closed && allowed(request.headers.host, request.headers.origin),
      ),
  });
  const cleanups = new Set<() => void>();
  io.on("connection", (socket) => {
    if (closed) {
      socket.disconnect(true);
      return;
    }
    let active = true;
    let worldView: WorldView | undefined;
    const removers: (() => void)[] = [];
    const chunkLoads = new Map<string, symbol>();
    const cleanup = () => {
      if (!active) return;
      active = false;
      for (const remove of removers) remove();
      chunkLoads.clear();
      cleanups.delete(cleanup);
    };
    const fail = () => {
      cleanup();
      socket.disconnect(true);
    };
    const listen = <K extends keyof BotEvents>(
      event: K,
      listener: (...args: Parameters<BotEvents[K]>) => unknown,
    ) => {
      const guarded = ((...args: Parameters<BotEvents[K]>) => {
        if (!active || closed) return;
        try {
          void Promise.resolve(listener(...args)).catch(fail);
        } catch {
          fail();
        }
      }) as BotEvents[K];
      bot.on(event, guarded);
      removers.push(() => bot.removeListener(event, guarded));
    };
    const position = () => {
      if (!active || closed) return;
      socket.emit("position", {
        pos: bot.entity.position,
        yaw: bot.entity.yaw,
        addMesh: !options.firstPerson,
        ...(options.firstPerson ? { pitch: bot.entity.pitch } : {}),
      });
      void worldView?.updatePosition(bot.entity.position).catch(fail);
    };
    const unload = (pos: Vec3) => {
      chunkLoads.delete(`${pos.x},${pos.z}`);
      worldView?.unloadChunk(pos);
    };
    cleanups.add(cleanup);
    socket.once("disconnect", cleanup);
    try {
      // WorldView normally installs mouseClick on its emitter. Deliberately do
      // not forward inbound events: viewing must never invoke bot actions.
      worldView = new dependencies.WorldView(
        bot.world,
        options.viewDistance,
        bot.entity.position,
        {
          emit(event, data) {
            if (active && !closed) socket.emit(event, data);
          },
          on() {},
        },
      );
      // The upstream loader has no cancellation or unload tokens. Own each
      // asynchronous read so closed tabs/unloaded columns cannot reappear.
      const view = worldView;
      view.loadChunk = async (pos) => {
        if (!active || closed) return;
        const dx = Math.abs(
          Math.floor(view.lastPos.x / 16) - Math.floor(pos.x / 16),
        );
        const dz = Math.abs(
          Math.floor(view.lastPos.z / 16) - Math.floor(pos.z / 16),
        );
        if (dx >= options.viewDistance || dz >= options.viewDistance) return;
        const key = `${pos.x},${pos.z}`;
        const token = Symbol();
        chunkLoads.set(key, token);
        try {
          const column = await bot.world.getColumnAt(pos);
          if (!active || closed || chunkLoads.get(key) !== token) return;
          chunkLoads.delete(key);
          if (
            Math.abs(
              Math.floor(view.lastPos.x / 16) - Math.floor(pos.x / 16),
            ) >= options.viewDistance ||
            Math.abs(
              Math.floor(view.lastPos.z / 16) - Math.floor(pos.z / 16),
            ) >= options.viewDistance
          )
            return;
          if (column) {
            socket.emit("loadChunk", {
              x: pos.x,
              z: pos.z,
              chunk: column.toJson(),
            });
            view.loadedChunks[key] = true;
          }
        } catch {
          fail();
        }
      };
      socket.emit("version", bot.version);
      const entitySpawn = (entity: Bot["entity"]) => {
        if (entity === bot.entity) return;
        socket.emit("entity", {
          id: entity.id,
          name: entity.name,
          pos: entity.position,
          width: entity.width,
          height: entity.height,
          username: entity.username,
        });
      };
      listen("entitySpawn", entitySpawn);
      listen("entityMoved", (entity) =>
        socket.emit("entity", {
          id: entity.id,
          pos: entity.position,
          pitch: entity.pitch,
          yaw: entity.yaw,
        }),
      );
      listen("entityGone", (entity) =>
        socket.emit("entity", { id: entity.id, delete: true }),
      );
      listen("chunkColumnLoad", (pos) => view.loadChunk(pos));
      listen("chunkColumnUnload", unload);
      listen("blockUpdate", (_oldBlock, block) =>
        socket.emit("blockUpdate", {
          pos: block.position,
          stateId: block.stateId ?? (block.type << 4) | block.metadata,
        }),
      );
      listen("move", position);
      for (const entity of Object.values(bot.entities)) entitySpawn(entity);
      position();
      void worldView.init(bot.entity.position).catch(fail);
    } catch {
      fail();
    }
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    for (const cleanup of cleanups) cleanup();
    closing = io.close().then(() => {});
    http.closeAllConnections();
    return closing;
  };
  try {
    await new Promise<void>((resolveListen, reject) => {
      const error = (failure: Error) => reject(failure);
      http.once("error", error);
      http.listen(
        { host: "127.0.0.1", port: options.port, exclusive: true },
        () => {
          http.removeListener("error", error);
          resolveListen();
        },
      );
    });
    const address = http.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== "127.0.0.1"
    )
      throw new Error("Viewer did not bind to IPv4 loopback");
    authority = `127.0.0.1:${address.port}`;
    // Keep asynchronous transport errors confined to this optional viewer.
    http.on("error", () => void close().catch(() => {}));
    return {
      get closed() {
        return closed;
      },
      info: {
        url: `http://${authority}/`,
        port: address.port,
        firstPerson: options.firstPerson,
        viewDistance: options.viewDistance,
        generation,
      },
      close,
    };
  } catch (error) {
    await close();
    throw new McjsError(
      "VIEWER_START_FAILED",
      `Could not start viewer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
