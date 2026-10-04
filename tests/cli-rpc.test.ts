import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Envelope, requestSchema } from "../src/protocol.ts";

type CliEnvelope = Pick<Envelope, "ok" | "data" | "error"> & Partial<Envelope>;

async function withDaemon(
  dispatch: (method: string, params: unknown) => Promise<unknown>,
  run: (
    cli: (...args: string[]) => Promise<{
      status: number;
      result: CliEnvelope;
      lines: CliEnvelope[];
    }>,
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "mcjs-cli-"));
  const socket = join(directory, "d.sock");
  await Bun.write(`${socket}.token`, "test-token");
  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      const input = requestSchema.parse(await request.json());
      const data = await dispatch(input.method, input.params);
      if (data instanceof Response) return data;
      return Response.json({
        protocolVersion: 1,
        requestId: input.requestId,
        ok: true,
        data,
        meta: { daemonId: "test", durationMs: 0 },
      });
    },
  });
  try {
    await run(async (...args) => {
      const child = Bun.spawn(
        [process.execPath, "src/cli.ts", ...args, "--socket", socket],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, , status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const lines = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CliEnvelope);
      return { status, result: lines.at(-1) as CliEnvelope, lines };
    });
  } finally {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "invalid execution and creation options cause no daemon mutations",
  async () => {
    const calls: string[] = [];
    await withDaemon(
      async (method) => {
        calls.push(method);
        return { id: crypto.randomUUID(), state: "running" };
      },
      async (cli) => {
        for (const args of [
          ["exec", "scout", "return 1", "--wait-ms=-1"],
          ["exec", "scout", "return 1", "--background", "--wait-ms=bad"],
          ["exec", "scout", "return 1", "--timeout-ms=0"],
          ["exec", "scout", "return 1", "--lang=python"],
          ["exec", "scout", "return 1", "--if-busy=invalid"],
          ["exec-many", "scout,bad/id", "return 1"],
          ["bot", "create", "scout", "--username=Scout", "--wait-ms=-1"],
          ["bot", "create", "scout", "--username=Scout", "--auth=invalid"],
        ]) {
          const { status, result } = await cli(...args);
          expect(status).toBe(2);
          expect(result.error?.code).toBe("INVALID_ARGUMENT");
        }
        expect(calls).toEqual([]);
      },
    );
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "compact jobs retain outcomes and user data without changing full output or exit codes",
  async () => {
    const job = {
      id: crypto.randomUUID(),
      botId: "scout",
      generation: 2,
      state: "succeeded",
      sourceHash: "abc",
      submittedAt: 1,
      startedAt: 2,
      endedAt: 3,
      result: { sourceHash: "user data", logs: [], meta: { keep: true } },
      logs: [] as unknown[],
      error: undefined as
        | { code: string; message: string; retryable: boolean }
        | undefined,
    };
    await withDaemon(
      async () => job,
      async (cli) => {
        const full = await cli("job", "get", job.id);
        expect(full.result.data).toEqual(JSON.parse(JSON.stringify(job)));
        expect(full.result.protocolVersion).toBe(1);
        for (const args of [
          ["exec", "scout", "return 1"],
          ["exec", "scout", "return 1", "--background"],
          ["job", "get", job.id],
          ["job", "wait", job.id],
          ["job", "cancel", job.id],
        ]) {
          const { status, result, lines } = await cli(...args, "--compact");
          expect(status).toBe(0);
          expect(lines).toHaveLength(1);
          expect(result).toEqual({
            ok: true,
            data: {
              id: job.id,
              botId: "scout",
              generation: 2,
              state: "succeeded",
              result: job.result,
            },
          });
        }
        job.state = "running";
        const pending = await cli(
          "exec",
          "scout",
          "return 1",
          "--wait-ms=0",
          "--compact",
        );
        expect(pending.status).toBe(0);
        expect(pending.result.data).toMatchObject({
          id: job.id,
          state: "running",
        });
        job.logs = [["useful diagnostic"]];
        job.error = {
          code: "DEADLINE_EXCEEDED",
          message: "deadline",
          retryable: false,
        };
        for (const [state, exit] of [
          ["failed", 1],
          ["timed_out", 4],
          ["canceled", 5],
        ] as const) {
          job.state = state;
          const failed = await cli(
            "exec",
            "scout",
            "throw Error()",
            "--compact",
          );
          expect(failed.status).toBe(exit);
          expect(failed.result).toMatchObject({
            ok: true,
            data: { state, error: job.error, logs: job.logs },
          });
        }
      },
    );
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "compact fleet and job lists preserve per-bot failures",
  async () => {
    const jobs = [
      {
        id: crypto.randomUUID(),
        botId: "a",
        state: "succeeded",
        result: null,
        logs: [],
        submittedAt: 1,
      },
      {
        id: crypto.randomUUID(),
        botId: "b",
        state: "failed",
        error: { code: "FAIL", message: "failed", retryable: false },
        logs: [],
        submittedAt: 1,
      },
    ];
    await withDaemon(
      async (method, params) => {
        if (method === "jobs.list") return jobs;
        const { botId, id } = params as { botId?: string; id?: string };
        if (botId === "c")
          return Response.json({
            protocolVersion: 1,
            requestId: "test",
            ok: false,
            error: { code: "BOT_NOT_READY", message: "c", retryable: false },
            meta: { daemonId: "test", durationMs: 0 },
          });
        return jobs.find((job) => job.id === id || job.botId === botId);
      },
      async (cli) => {
        const { status, result } = await cli(
          "exec-many",
          "a,b,c",
          "return null",
          "--compact",
        );
        expect(status).toBe(6);
        expect(result).toEqual({
          ok: true,
          data: {
            a: {
              ok: true,
              data: {
                id: jobs[0]?.id,
                botId: "a",
                state: "succeeded",
                result: null,
              },
            },
            b: {
              ok: true,
              data: {
                id: jobs[1]?.id,
                botId: "b",
                state: "failed",
                error: jobs[1]?.error,
              },
            },
            c: {
              ok: false,
              error: { code: "BOT_NOT_READY", message: "c", retryable: false },
            },
          },
        });
        const list = await cli("jobs", "list", "--compact");
        expect(list.result.data).toEqual([
          { id: jobs[0]?.id, botId: "a", state: "succeeded", result: null },
          {
            id: jobs[1]?.id,
            botId: "b",
            state: "failed",
            error: jobs[1]?.error,
          },
        ]);
      },
    );
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "event filtering advances cursors through excluded pages and quiet follow preserves errors",
  async () => {
    for (const includeEmpty of [false, true]) {
      let reads = 0;
      const cursors: unknown[] = [];
      await withDaemon(
        async (method, params) => {
          expect(method).toBe("events");
          cursors.push((params as { since?: string }).since);
          reads++;
          if (reads === 5)
            return Response.json({
              protocolVersion: 1,
              requestId: "test",
              ok: false,
              error: {
                code: "CURSOR_INVALID",
                message: "reconnected",
                retryable: false,
              },
              meta: { daemonId: "test", durationMs: 0 },
            });
          return {
            events:
              reads < 3
                ? [{ type: "job", payload: { state: "running" } }]
                : reads === 3
                  ? [
                      {
                        type: "chat",
                        payload: { message: "hello", untrusted: true },
                      },
                    ]
                  : [],
            cursor: `cursor-${reads}`,
            hasMore: reads < 3,
          };
        },
        async (cli) => {
          const { status, lines } = await cli(
            "events",
            "scout",
            "--follow",
            "--types=chat,health",
            "--compact",
            ...(includeEmpty ? ["--include-empty"] : []),
          );
          expect(status).toBe(1);
          expect(lines).toHaveLength(includeEmpty ? 5 : 3);
          expect(lines[0]).toEqual({
            ok: true,
            data: { events: [], cursor: "cursor-1", hasMore: true },
          });
          expect(lines.at(-2)).toMatchObject({
            ok: true,
            data: includeEmpty
              ? { cursor: "cursor-4", events: [] }
              : {
                  cursor: "cursor-3",
                  events: [
                    {
                      type: "chat",
                      payload: { message: "hello", untrusted: true },
                    },
                  ],
                },
          });
          expect(lines.at(-1)).toMatchObject({
            ok: false,
            error: { code: "CURSOR_INVALID" },
          });
          expect(cursors).toEqual([
            undefined,
            "cursor-1",
            "cursor-2",
            "cursor-3",
            "cursor-4",
          ]);
        },
      );
    }
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "one-shot filtered events still print an empty batch and invalid filters make no RPC",
  async () => {
    let reads = 0;
    await withDaemon(
      async () => {
        reads++;
        return { events: [{ type: "job" }], cursor: "next", hasMore: true };
      },
      async (cli) => {
        const empty = await cli("events", "scout", "--types=chat");
        expect(empty.result.data).toEqual({
          events: [],
          cursor: "next",
          hasMore: true,
        });
        for (const types of ["", "chat,", "chat,,health"]) {
          const invalid = await cli("events", "scout", `--types=${types}`);
          expect(invalid.status).toBe(2);
        }
        expect(reads).toBe(1);
      },
    );
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "bot creation defaults to offline and preserves Microsoft opt-in",
  async () => {
    const configs: unknown[] = [];
    await withDaemon(
      async (method, params) => {
        if (method === "bot.create") configs.push(params);
        return { state: "ready", authPrompt: null };
      },
      async (cli) => {
        for (const auth of [[], ["--auth", "microsoft"]]) {
          const { status, result } = await cli(
            "bot",
            "create",
            "scout",
            "--username",
            "Scout",
            ...auth,
          );
          expect(status).toBe(0);
          expect(result.ok).toBe(true);
        }
        expect(configs).toHaveLength(2);
        expect(configs[0]).toMatchObject({ auth: "offline" });
        expect(configs[1]).toMatchObject({ auth: "microsoft" });
      },
    );
  },
);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "fleet submission is limited to four without waiting for earlier jobs",
  async () => {
    let activeSubmissions = 0;
    let maximumSubmissions = 0;
    let submitted = 0;
    const jobs = new Map<
      string,
      { id: string; botId: string; state: string }
    >();
    await withDaemon(
      async (method, params) => {
        if (method === "exec.submit") {
          activeSubmissions++;
          maximumSubmissions = Math.max(maximumSubmissions, activeSubmissions);
          await Bun.sleep(20);
          activeSubmissions--;
          submitted++;
          const job = {
            id: crypto.randomUUID(),
            botId: (params as { botId: string }).botId,
            state: "running",
          };
          jobs.set(job.id, job);
          return job;
        }
        const job = jobs.get((params as { id: string }).id);
        return { ...job, state: submitted === 5 ? "succeeded" : "running" };
      },
      async (cli) => {
        const { status, result } = await cli(
          "exec-many",
          "a,b,c,d,e",
          "return 'five-bot barrier'",
          "--wait-ms=50",
        );
        expect(status).toBe(0);
        expect(submitted).toBe(5);
        expect(maximumSubmissions).toBe(4);
        const fleet = result.data as Record<
          string,
          Envelope<{ state: string }>
        >;
        expect(Object.keys(fleet).sort()).toEqual(["a", "b", "c", "d", "e"]);
        for (const job of Object.values(fleet))
          expect(job.data?.state).toBe("succeeded");
      },
    );
  },
);
