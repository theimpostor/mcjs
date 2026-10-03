import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Envelope } from "../src/protocol.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "mcjs-build-"));
const binary = join(directory, "mcjs");
const linked = join(directory, "mcjs-link");
const socket = join(directory, "d.sock");
const emptyPath = join(directory, "empty-bin");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: emptyPath,
  MCJS_RUNTIME_DIR: join(directory, "runtime"),
  MCJS_STATE_DIR: join(directory, "state"),
};
delete env.BUN_BE_BUN;

async function subprocess(
  command: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
  timeout = 15_000,
) {
  const child = Bun.spawn(command, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0)
      throw new Error(`Command exited ${status}: ${stdout}\n${stderr}`);
    return stdout;
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

async function cli<T>(executable: string, ...args: string[]) {
  const stdout = await subprocess([executable, ...args, "--socket", socket], {
    cwd: directory,
    env,
  });
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const response = JSON.parse(stdout) as Envelope<T>;
  expect(response.ok).toBe(true);
  return response;
}

beforeAll(async () => {
  await subprocess([process.execPath, "run", "build"], { cwd: root }, 60_000);
  mkdirSync(emptyPath);
  copyFileSync(join(root, "dist", "mcjs"), binary);
  symlinkSync(binary, linked);
}, 65_000);

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

test("a copied standalone binary provides its assets directly and through a symlink", async () => {
  for (const executable of [binary, linked]) {
    expect((await cli<string>(executable, "--help")).data).toContain(
      "mcjs exec",
    );
    const docs = await cli<{ text: string; versions: Record<string, string> }>(
      executable,
      "docs",
      "execution",
    );
    expect(docs.data?.text).toBe(
      await Bun.file(join(root, "docs", "execution.md")).text(),
    );
    expect(docs.data?.versions.mineflayer).toBe("4.39.0");
    const skillPath = (await cli<string>(executable, "skill", "path")).data;
    if (!skillPath) throw new Error("Missing extracted skill path");
    expect(skillPath.startsWith(join(directory, "state"))).toBe(true);
    for (const path of ["SKILL.md", "references/workflow.md"])
      expect(await Bun.file(join(dirname(skillPath), path)).text()).toBe(
        await Bun.file(join(root, "skills", "mcjs", path)).text(),
      );
    expect((await cli<string>(executable, "skill", "print")).data).toBe(
      await Bun.file(join(root, "skills", "mcjs", "SKILL.md")).text(),
    );
    const doctor = await cli<{
      socket: string;
      daemon: { available: boolean; error: { code: string } };
      dependencies: Record<string, string>;
    }>(executable, "doctor");
    expect(doctor.data?.socket).toBe(socket);
    expect(doctor.data?.daemon.available).toBe(false);
    expect(doctor.data?.daemon.error.code).toBe("DAEMON_UNAVAILABLE");
    expect(doctor.data?.dependencies.mineflayer).toBe("4.39.0");
  }
  const destination = join(directory, "installed-skills");
  expect(
    (
      await cli<{ installed: string }>(
        linked,
        "skill",
        "install",
        "--dir",
        destination,
      )
    ).data,
  ).toEqual({ installed: join(destination, "mcjs") });
  for (const path of ["SKILL.md", "references/workflow.md"])
    expect(await Bun.file(join(destination, "mcjs", path)).text()).toBe(
      await Bun.file(join(root, "skills", "mcjs", path)).text(),
    );
}, 20_000);

test.skipIf(process.env.MCJS_SKIP_UNIX === "1")(
  "a copied standalone binary manages its daemon without Bun on PATH",
  async () => {
    let pid: number | undefined;
    try {
      const started = await cli<{ pid: number; daemonId: string }>(
        linked,
        "daemon",
        "start",
      );
      pid = started.data?.pid;
      expect(pid).toBeNumber();
      expect(pid).not.toBe(process.pid);
      const status = await cli<{ pid: number; daemonId: string }>(
        binary,
        "daemon",
        "status",
      );
      expect(status.data).toMatchObject({
        pid,
        daemonId: started.data?.daemonId,
      });
      expect((await cli(linked, "daemon", "start")).data).toEqual(status.data);
      expect((await cli(linked, "daemon", "stop")).data).toEqual({
        stopping: true,
      });
      const deadline = Date.now() + 3_000;
      while (existsSync(socket) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(socket)).toBe(false);
      expect(existsSync(`${socket}.token`)).toBe(false);
      expect(existsSync(`${socket}.json`)).toBe(false);
    } finally {
      // The daemon is a grandchild; recover its PID if the start response failed.
      if (pid === undefined && existsSync(`${socket}.json`)) {
        const metadata = await Bun.file(`${socket}.json`).json();
        pid = metadata.pid;
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      const deadline = Date.now() + 2_000;
      while (existsSync(socket) && Date.now() < deadline) await Bun.sleep(20);
      if (existsSync(socket) && pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  },
  20_000,
);
