import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Envelope, requestSchema } from "../src/protocol.ts";

async function withDaemon(
  dispatch: (method: string, params: unknown) => Promise<unknown>,
  run: (
    cli: (...args: string[]) => Promise<{ status: number; result: Envelope }>,
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
      return Response.json({
        protocolVersion: 1,
        requestId: input.requestId,
        ok: true,
        data: await dispatch(input.method, input.params),
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
      return { status, result: JSON.parse(stdout) as Envelope };
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
