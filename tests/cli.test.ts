import { expect, test } from "bun:test";
import { join } from "node:path";

async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  return { status: await child.exited, stdout, envelope: JSON.parse(stdout) };
}

test("help and offline docs do not need a daemon", async () => {
  const help = await cli("--help");
  expect(help.status).toBe(0);
  expect(help.envelope.data).toContain("exec-many");
  expect(help.envelope.data).toContain("viewer start <id>");
  for (const topic of [
    "index",
    "execution",
    "navigation",
    "inventory",
    "coordination",
    "connection",
    "troubleshooting",
  ]) {
    const docs = await cli("docs", topic);
    expect(docs.status).toBe(0);
    expect(docs.envelope.data.versions.mineflayer).toBe("4.39.0");
  }
});

test("skill discovery finds the bundled skill and references", async () => {
  const path = await cli("skill", "path");
  expect(await Bun.file(path.envelope.data).exists()).toBe(true);
  const print = await cli("skill", "print");
  expect(print.envelope.data).toStartWith("---\nname: mcjs\n");
  expect(
    await Bun.file(
      join(process.cwd(), "skills/mcjs/references/workflow.md"),
    ).exists(),
  ).toBe(true);
});

test("invalid CLI requests fail with one JSON envelope", async () => {
  const result = await cli("exec", "scout", "return 1", "--stdin");
  expect(result.status).toBe(2);
  expect(result.envelope.error.code).toBe("INVALID_ARGUMENT");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect((await cli("docs", "../package")).status).toBe(2);
  const compact = await cli(
    "exec",
    "scout",
    "return 1",
    "--stdin",
    "--compact",
  );
  expect(compact.status).toBe(2);
  expect(Object.keys(compact.envelope).sort()).toEqual(["error", "ok"]);
  expect(compact.envelope.error.code).toBe("INVALID_ARGUMENT");
});

test("human docs print readable Markdown without JSON escaping", async () => {
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "docs", "execution", "--human"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(stdout).toBe(`${await Bun.file("docs/execution.md").text()}\n`);
});
