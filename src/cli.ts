#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { skillDirectory } from "./assets.ts";
import { errorData, McjsError, requireValue } from "./errors.ts";
import { Client } from "./ipc/client.ts";
import { runtimePaths } from "./ipc/paths.ts";
import { compactEnvelope, type OutputKind } from "./output.ts";
import { packageRoot } from "./package-root.ts";
import {
  botConfigSchema,
  type Envelope,
  execSchema,
  idSchema,
  PROTOCOL,
  VERSION,
  viewerStartSchema,
} from "./protocol.ts";
import { isTerminal, type Job } from "./runtime/jobs.ts";

const options = {
  help: { type: "boolean", short: "h" },
  human: { type: "boolean" },
  compact: { type: "boolean" },
  profile: { type: "string", default: "default" },
  socket: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "first-person": { type: "boolean" },
  "view-distance": { type: "string" },
  username: { type: "string" },
  auth: { type: "string" },
  version: { type: "string" },
  plugins: { type: "string" },
  file: { type: "string" },
  stdin: { type: "boolean" },
  lang: { type: "string" },
  background: { type: "boolean" },
  "timeout-ms": { type: "string" },
  "wait-ms": { type: "string" },
  "if-busy": { type: "string" },
  since: { type: "string" },
  follow: { type: "boolean" },
  types: { type: "string" },
  "include-empty": { type: "boolean" },
  dir: { type: "string" },
  force: { type: "boolean" },
  revision: { type: "string" },
} as const;

function numberOption(value: string | undefined, fallback: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new McjsError(
      "INVALID_ARGUMENT",
      `Expected a nonnegative integer: ${value}`,
    );
  return number;
}
const help = `mcjs ${VERSION} — programmable Minecraft bots

mcjs daemon start|status|stop
mcjs doctor
mcjs bot create <id> --username <name> [--host localhost --port 25565 --auth offline|microsoft]
mcjs bot list|info|snapshot|stop|remove|reconnect [id]
mcjs viewer start <id> [--port 0 --first-person --view-distance 6]
mcjs viewer stop <id>
mcjs exec <bot> '<JavaScript>' [--background --timeout-ms 30000 --wait-ms 30000]
mcjs exec <bot> --stdin|--file script.ts [--lang js|ts]
mcjs exec-all '<code>' | exec-many bot1,bot2 '<code>'
mcjs jobs list | job get|wait|cancel <job-id>
mcjs events <bot> [--since cursor --follow --types chat,health --include-empty]
mcjs inspect <bot> bot|bot.inventory|bot.pathfinder|bot.collectBlock|bot.tool|bot.pvp
mcjs state get <bot> | state set <bot> '<JSON object>'
mcjs shared get <key> | shared set <key> '<JSON>' --revision <n>
mcjs docs [topic]
mcjs skill path|print|install [--dir <skill-root> --force]

Global: --profile default --socket <path> --compact --human
Bot authentication defaults to offline; use --auth microsoft for online-mode servers.
Viewer listens on loopback only; port 0 selects an available port for each bot.
JSON stdout by default. JavaScript runs as a trusted async function body; return results.
--compact omits transport metadata and job bookkeeping; keeps states, results and errors.
Use --stdin with a quoted heredoc to prevent shell interpolation. See mcjs docs.
`;

export async function main(args = process.argv.slice(2)) {
  const { values: flags, positionals: p } = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: true,
  });
  const [command, action, target] = p;
  const client = new Client(runtimePaths(flags.profile, flags.socket));
  const emit = (envelope: Envelope, kind: OutputKind = "data") =>
    console.log(
      JSON.stringify(
        flags.compact ? compactEnvelope(envelope, kind) : envelope,
        null,
        flags.human ? 2 : undefined,
      ),
    );
  const output = (data: unknown, kind: OutputKind = "data") => {
    if (flags.human && typeof data === "string") console.log(data);
    else
      emit(
        {
          protocolVersion: PROTOCOL,
          requestId: crypto.randomUUID(),
          ok: true,
          data,
          meta: { daemonId: "local", durationMs: 0 },
        },
        kind,
      );
  };
  const rpc = async (
    method: string,
    params: unknown = {},
    kind: OutputKind = "data",
  ) => emit(await client.rpc(method, params), kind);
  const required = (value: string | undefined, name: string) =>
    requireValue(value, `Missing ${name}; run mcjs --help`);
  if (flags.help || !command) {
    output(help);
    return;
  }
  if (command === "docs") {
    const topic = action ?? "index";
    if (!/^[a-z0-9-]+$/.test(topic))
      throw new McjsError("INVALID_ARGUMENT", "Invalid docs topic");
    const file = Bun.file(join(packageRoot, "docs", `${topic}.md`));
    if (!(await file.exists()))
      throw new McjsError(
        "DOCS_NOT_FOUND",
        `Unknown topic ${topic}; run mcjs docs`,
      );
    const text = await file.text();
    output(
      flags.human
        ? text
        : {
            topic,
            text,
            versions: (await Bun.file(join(packageRoot, "package.json")).json())
              .dependencies,
          },
    );
    return;
  }
  if (command === "skill") {
    if (action === "path")
      output(join(await skillDirectory(client.paths), "SKILL.md"));
    else if (action === "print")
      output(
        await Bun.file(join(packageRoot, "skills", "mcjs", "SKILL.md")).text(),
      );
    else if (action === "install") {
      const destination = join(resolve(required(flags.dir, "--dir")), "mcjs");
      if (existsSync(destination) && !flags.force)
        throw new McjsError(
          "ALREADY_EXISTS",
          `${destination}; pass --force to overwrite`,
        );
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(await skillDirectory(client.paths), destination, {
        recursive: true,
        force: flags.force ?? false,
      });
      output({ installed: destination });
    } else
      throw new McjsError(
        "INVALID_ARGUMENT",
        "Use skill path, print or install",
      );
    return;
  }
  if (command === "daemon") {
    if (action === "start") emit(await client.start(flags.profile));
    else if (action === "status") await rpc("status");
    else if (action === "stop") await rpc("daemon.stop");
    else
      throw new McjsError(
        "INVALID_ARGUMENT",
        "Use daemon start, status or stop",
      );
    return;
  }
  if (command === "doctor") {
    const pkg = await Bun.file(join(packageRoot, "package.json")).json();
    let daemon: unknown;
    try {
      daemon = (await client.rpc("status")).data;
    } catch (error) {
      daemon = { available: false, error: errorData(error) };
    }
    output({
      version: VERSION,
      bun: Bun.version,
      socket: client.paths.socket,
      daemon,
      dependencies: pkg.dependencies,
    });
    return;
  }
  if (command === "bot") {
    if (action === "list") {
      await rpc("bot.list");
      return;
    }
    const id = required(target, "bot ID");
    if (action === "create") {
      const config = botConfigSchema.safeParse({
        id,
        username: required(flags.username, "--username"),
        host: flags.host,
        port: numberOption(flags.port, 25565),
        auth: flags.auth,
        version: flags.version,
        plugins: flags.plugins?.split(","),
      });
      if (!config.success)
        throw new McjsError("INVALID_ARGUMENT", config.error.message);
      const waitMs = numberOption(
        flags["wait-ms"],
        config.data.auth === "offline" ? 30_000 : 300_000,
      );
      await client.start(flags.profile);
      await client.rpc("bot.create", config.data);
      const until = Date.now() + waitMs;
      let printedAuth = false;
      for (;;) {
        const envelope = await client.rpc<{
          state: string;
          authPrompt: { uri: string; code: string } | null;
        }>("bot.info", { id });
        if (envelope.data?.authPrompt && !printedAuth) {
          console.error(
            `Microsoft login: ${envelope.data.authPrompt.uri} code ${envelope.data.authPrompt.code}`,
          );
          printedAuth = true;
        }
        if (envelope.data?.state === "ready" || Date.now() >= until) {
          emit(envelope);
          return;
        }
        if (["failed", "disconnected"].includes(envelope.data?.state ?? ""))
          throw new McjsError("CONNECT_FAILED", JSON.stringify(envelope.data));
        await Bun.sleep(200);
      }
    }
    if (
      !["info", "snapshot", "remove", "reconnect", "stop"].includes(
        action ?? "",
      )
    )
      throw new McjsError("INVALID_ARGUMENT", "Unknown bot command");
    await rpc(`bot.${action}`, { id });
    return;
  }
  if (command === "viewer") {
    if (action !== "start" && action !== "stop")
      throw new McjsError("INVALID_ARGUMENT", "Use viewer start or stop");
    if (p.length > 3)
      throw new McjsError("INVALID_ARGUMENT", "Expected one viewer bot ID");
    const id = idSchema.safeParse(required(target, "bot ID"));
    if (!id.success) throw new McjsError("INVALID_ARGUMENT", id.error.message);
    if (action === "stop") {
      if (
        flags.port !== undefined ||
        flags["first-person"] !== undefined ||
        flags["view-distance"] !== undefined
      )
        throw new McjsError(
          "INVALID_ARGUMENT",
          "Viewer options apply only to viewer start",
        );
      await rpc("viewer.stop", { id: id.data });
    } else {
      const input = viewerStartSchema.safeParse({
        id: id.data,
        port: numberOption(flags.port, 0),
        firstPerson: flags["first-person"],
        viewDistance: numberOption(flags["view-distance"], 6),
      });
      if (!input.success)
        throw new McjsError("INVALID_ARGUMENT", input.error.message);
      await rpc("viewer.start", input.data);
    }
    return;
  }
  async function waitJob(id: string, waitMs: number) {
    const until = Date.now() + waitMs;
    for (;;) {
      const result = await client.rpc<Job>("job.get", { id });
      if (!result.data || isTerminal(result.data) || Date.now() >= until)
        return result;
      await Bun.sleep(100);
    }
  }
  const jobExit = (job?: Job) => {
    if (!job || !isTerminal(job) || job.state === "succeeded") return 0;
    return job.state === "timed_out" ? 4 : job.state === "canceled" ? 5 : 1;
  };
  if (["exec", "exec-all", "exec-many"].includes(command)) {
    const inline = command === "exec-all" ? action : target;
    if (
      [
        inline !== undefined,
        flags.file !== undefined,
        flags.stdin === true,
      ].filter(Boolean).length !== 1
    )
      throw new McjsError(
        "INVALID_ARGUMENT",
        "Provide exactly one code argument, --file or --stdin",
      );
    const code = flags.file
      ? await Bun.file(flags.file).text()
      : flags.stdin
        ? await Bun.stdin.text()
        : required(inline, "code");
    let ids: string[];
    if (command === "exec-all") {
      const response =
        await client.rpc<{ id: string; state: string }[]>("bot.list");
      ids = (response.data ?? [])
        .filter((s) => s.state === "ready")
        .map((s) => s.id);
    } else
      ids =
        command === "exec"
          ? [required(action, "bot ID")]
          : required(action, "bot IDs").split(",");
    if (ids.length === 0 || new Set(ids).size !== ids.length)
      throw new McjsError(
        "INVALID_ARGUMENT",
        "Select at least one bot without duplicate IDs",
      );
    const timeoutMs = numberOption(flags["timeout-ms"], 30_000);
    const waitMs = numberOption(flags["wait-ms"], timeoutMs + 3_000);
    const inputs = ids.map((id) => {
      const parsed = execSchema.safeParse({
        botId: id,
        code,
        lang: flags.lang ?? (flags.file?.endsWith(".ts") ? "ts" : "js"),
        timeoutMs,
        ifBusy: flags["if-busy"] ?? "queue",
      });
      if (!parsed.success)
        throw new McjsError("INVALID_ARGUMENT", parsed.error.message);
      return parsed.data;
    });
    const results: Record<string, unknown> = Object.create(null);
    let failures = 0;
    const waitForReceipt = (result: Envelope<Job>) =>
      flags.background || !result.data
        ? result
        : waitJob(result.data.id, waitMs);
    if (command === "exec") {
      const result = await waitForReceipt(
        await client.rpc<Job>("exec.submit", inputs[0]),
      );
      emit(result, "job");
      process.exitCode = jobExit(result.data);
      return;
    }
    const receipts: { id: string; result: Envelope<Job> }[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(inputs.length, 4) }, async () => {
        for (;;) {
          const input = inputs[next++];
          if (!input) return;
          try {
            receipts.push({
              id: input.botId,
              result: await client.rpc<Job>("exec.submit", input),
            });
          } catch (error) {
            results[input.botId] = { ok: false, error: errorData(error) };
            failures++;
          }
        }
      }),
    );
    await Promise.all(
      receipts.map(async ({ id, result: receipt }) => {
        try {
          const result = await waitForReceipt(receipt);
          results[id] = result;
          if (jobExit(result.data)) failures++;
        } catch (error) {
          results[id] = { ok: false, error: errorData(error) };
          failures++;
        }
      }),
    );
    output(results, "fleet");
    if (failures) process.exitCode = 6;
    return;
  }
  if (command === "jobs" && action === "list") {
    await rpc("jobs.list", {}, "jobs");
    return;
  }
  if (command === "job") {
    const id = required(target, "job ID");
    if (action === "wait") {
      const result = await waitJob(id, numberOption(flags["wait-ms"], 30_000));
      emit(result, "job");
      process.exitCode = jobExit(result.data);
    } else if (action === "get" || action === "cancel")
      await rpc(`job.${action}`, { id }, "job");
    else throw new McjsError("INVALID_ARGUMENT", "Use job get, wait or cancel");
    return;
  }
  if (command === "events") {
    const id = required(action, "bot ID");
    const types = flags.types?.split(",").map((type) => type.trim());
    if (types?.some((type) => !/^[a-z][a-z0-9_-]*$/.test(type)))
      throw new McjsError(
        "INVALID_ARGUMENT",
        "--types expects comma-separated event types",
      );
    let since = flags.since;
    let first = true;
    do {
      const result = await client.rpc<{
        events: { type: string }[];
        cursor: string;
        hasMore: boolean;
      }>("events", { id, since });
      if (types && result.data)
        result.data.events = result.data.events.filter((event) =>
          types.includes(event.type),
        );
      if (
        first ||
        !flags.follow ||
        flags["include-empty"] ||
        result.data?.events.length
      )
        emit(result);
      first = false;
      since = result.data?.cursor;
      if (flags.follow && !result.data?.hasMore) await Bun.sleep(500);
    } while (flags.follow);
    return;
  }
  if (command === "inspect") {
    await rpc("inspect", {
      id: required(action, "bot ID"),
      path: target ?? "bot",
    });
    return;
  }
  if (command === "state" || command === "shared") {
    const key = required(target, command === "state" ? "bot ID" : "key");
    if (action !== "get" && action !== "set")
      throw new McjsError("INVALID_ARGUMENT", "Use get or set");
    await rpc(`${command}.${action}`, {
      [command === "state" ? "id" : "key"]: key,
      ...(action === "set"
        ? {
            value: JSON.parse(required(p[3], "JSON value")),
            ...(command === "shared"
              ? {
                  expectedRevision: numberOption(
                    required(flags.revision, "--revision"),
                    0,
                  ),
                }
              : {}),
          }
        : {}),
    });
    return;
  }
  throw new McjsError(
    "INVALID_ARGUMENT",
    `Unknown command: ${command}; run mcjs --help`,
  );
}

export async function runCli(args = process.argv.slice(2)) {
  await main(args).catch((error) => {
    const data = errorData(error);
    const envelope: Envelope = {
      protocolVersion: PROTOCOL,
      requestId: "local",
      ok: false,
      error: data,
      meta: { daemonId: "local", durationMs: 0 },
    };
    console.log(
      JSON.stringify(
        args.includes("--compact") ? compactEnvelope(envelope) : envelope,
      ),
    );
    process.exitCode =
      data.code === "INVALID_ARGUMENT" ||
      error instanceof SyntaxError ||
      error instanceof TypeError
        ? 2
        : data.code === "DAEMON_UNAVAILABLE"
          ? 3
          : 1;
  });
}

if (import.meta.main) void runCli();
