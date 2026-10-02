import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { errorData, McjsError } from "../errors.ts";
import { Deduplicator } from "../ipc/dedup.ts";
import { privateDirectory, type RuntimePaths } from "../ipc/paths.ts";
import {
  botConfigSchema,
  type Envelope,
  execSchema,
  idSchema,
  PROTOCOL,
  requestSchema,
  VERSION,
} from "../protocol.ts";
import { BotManager } from "../runtime/bots.ts";
import { serialize } from "../runtime/serialize.ts";

const botId = z.object({ id: idSchema }).strict();
const jobId = z.object({ id: z.uuid() }).strict();
const empty = z.object({}).strict();

type Listener = (handler: (request: Request) => Promise<Response>) => {
  stop(close: boolean): void | Promise<void>;
};

export async function startServer(paths: RuntimePaths, listen?: Listener) {
  process.umask(0o077);
  privateDirectory(paths.directory);
  privateDirectory(paths.auth);
  if (existsSync(paths.socket))
    throw new McjsError(
      "SOCKET_EXISTS",
      "Socket already exists; inspect daemon status before removing it",
    );
  const daemonId = crypto.randomUUID();
  const token = crypto.randomUUID() + crypto.randomUUID();
  await Bun.write(paths.token, token, { mode: 0o600 });
  const bots = new BotManager(daemonId, paths.auth);
  const dedup = new Deduplicator<Envelope>();
  const status = () => ({
    daemonId,
    pid: process.pid,
    version: VERSION,
    protocolVersion: PROTOCOL,
    bun: Bun.version,
    bots: bots.sessions.size,
  });
  let stopping = false;
  const dispatch = async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    switch (method) {
      case "status":
        empty.parse(params);
        return status();
      case "daemon.stop":
        empty.parse(params);
        setTimeout(stop, 50);
        return { stopping: true };
      case "bot.create":
        return bots.create(botConfigSchema.parse(params));
      case "bot.list":
        empty.parse(params);
        return [...bots.sessions.values()].map((s) => s.info());
      case "bot.info":
        return bots.get(botId.parse(params).id).info();
      case "bot.snapshot":
        return bots.get(botId.parse(params).id).snapshot();
      case "bot.remove":
        return bots.remove(botId.parse(params).id);
      case "bot.reconnect":
        return bots.reconnect(botId.parse(params).id);
      case "bot.stop":
        return bots.get(botId.parse(params).id).stop();
      case "exec.submit": {
        const input = execSchema.parse(params);
        return bots.get(input.botId).submit(input);
      }
      case "jobs.list":
        empty.parse(params);
        return bots
          .jobs()
          .slice(-1000)
          .map(
            ({
              id,
              botId,
              generation,
              state,
              submittedAt,
              startedAt,
              endedAt,
              error,
            }) => ({
              id,
              botId,
              generation,
              state,
              submittedAt,
              startedAt,
              endedAt,
              error,
            }),
          );
      case "job.get": {
        const { id } = jobId.parse(params);
        return bots.jobQueue(id).get(id);
      }
      case "job.cancel": {
        const { id } = jobId.parse(params);
        return bots.jobQueue(id).cancel(id);
      }
      case "events": {
        const { id, since } = z
          .object({ id: idSchema, since: z.string().optional() })
          .strict()
          .parse(params);
        return bots.get(id).events.read(since);
      }
      case "inspect": {
        const { id, path } = z
          .object({ id: idSchema, path: z.string() })
          .strict()
          .parse(params);
        const session = bots.get(id);
        const allowed: Record<string, unknown> = {
          bot: session.bot,
          "bot.pathfinder": session.bot.pathfinder,
          "bot.inventory": session.bot.inventory,
          "bot.collectBlock": session.bot.collectBlock,
          "bot.tool": session.bot.tool,
          "bot.pvp": session.bot.pvp,
        };
        const object = allowed[path];
        if (!object)
          throw new McjsError(
            "INVALID_ARGUMENT",
            `Allowed paths: ${Object.keys(allowed).join(", ")}`,
          );
        const methods = new Set<string>();
        const properties = new Set<string>();
        let current = object;
        for (
          let depth = 0;
          depth < 3 && current && current !== Object.prototype;
          depth++, current = Object.getPrototypeOf(current)
        ) {
          for (const [key, descriptor] of Object.entries(
            Object.getOwnPropertyDescriptors(current),
          )) {
            if (key.startsWith("_") || key === "constructor") continue;
            (typeof descriptor.value === "function" ? methods : properties).add(
              key,
            );
          }
        }
        return {
          path,
          methods: [...methods].sort(),
          properties: [...properties].sort(),
        };
      }
      case "state.get":
        return bots.get(botId.parse(params).id).botState;
      case "state.set": {
        const { id, value } = z
          .object({ id: idSchema, value: z.record(z.string(), z.json()) })
          .strict()
          .parse(params);
        const session = bots.get(id);
        if (session.queue.busy)
          throw new McjsError(
            "BOT_BUSY",
            "Cannot replace state while an execution is active",
          );
        session.botState = value;
        return serialize(value);
      }
      case "shared.get":
        return bots.shared.get(
          z.object({ key: z.string() }).strict().parse(params).key,
        );
      case "shared.set": {
        const { key, value, expectedRevision } = z
          .object({
            key: z.string(),
            value: z.json(),
            expectedRevision: z.number().int().min(0),
          })
          .strict()
          .parse(params);
        return bots.shared.set(key, value, { expectedRevision });
      }
      default:
        throw new McjsError("METHOD_NOT_FOUND", method);
    }
  };
  const readMethods = new Set([
    "status",
    "bot.list",
    "bot.info",
    "bot.snapshot",
    "jobs.list",
    "job.get",
    "events",
    "inspect",
    "state.get",
    "shared.get",
  ]);
  const handler = async (req: Request) => {
    const started = performance.now();
    let requestId = "unknown";
    const envelope = (ok: boolean, value: unknown): Envelope => ({
      protocolVersion: PROTOCOL,
      requestId,
      ok,
      ...(ok ? { data: value } : { error: errorData(value) }),
      meta: { daemonId, durationMs: Math.round(performance.now() - started) },
    });
    try {
      const received = Buffer.from(req.headers.get("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw new McjsError("UNAUTHORIZED", "Invalid daemon token");
      const url = new URL(req.url);
      if (url.pathname === "/v1/status" && req.method === "GET")
        return Response.json(envelope(true, status()));
      if (url.pathname !== "/v1/rpc" || req.method !== "POST")
        return Response.json(
          envelope(false, new McjsError("NOT_FOUND", "Unknown endpoint")),
          { status: 404 },
        );
      if (!req.headers.get("content-type")?.startsWith("application/json"))
        throw new McjsError("INVALID_ARGUMENT", "Expected application/json");
      const request = requestSchema.parse(await req.json());
      requestId = request.requestId;
      if (stopping) throw new McjsError("STOPPING", "Daemon is stopping");
      const run = async () => {
        try {
          return envelope(
            true,
            serialize(await dispatch(request.method, request.params)),
          );
        } catch (error) {
          return envelope(
            false,
            error instanceof z.ZodError
              ? new McjsError("INVALID_ARGUMENT", error.message)
              : error,
          );
        }
      };
      const result = readMethods.has(request.method)
        ? await run()
        : await dedup.run(
            requestId,
            JSON.stringify({
              method: request.method,
              params: request.params,
            }),
            run,
          );
      return Response.json(result);
    } catch (error) {
      return Response.json(
        envelope(
          false,
          error instanceof z.ZodError
            ? new McjsError("INVALID_ARGUMENT", error.message)
            : error,
        ),
        { status: 400 },
      );
    }
  };
  const server = listen
    ? listen(handler)
    : Bun.serve({
        unix: paths.socket,
        maxRequestBodySize: 1024 * 1024,
        fetch: handler,
      });
  if (!listen) chmodSync(paths.socket, 0o600);
  await Bun.write(paths.metadata, JSON.stringify(status()), { mode: 0o600 });
  async function stop() {
    if (stopping) return;
    stopping = true;
    bots.stop();
    await server.stop(true);
    for (const path of [paths.socket, paths.token, paths.metadata]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  return { server, stop, status, bots };
}
