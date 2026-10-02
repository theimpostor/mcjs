import { describe, expect, test } from "bun:test";
import { Vec3 } from "vec3";
import { Deduplicator } from "../src/ipc/dedup.ts";
import { EventBuffer } from "../src/runtime/events.ts";
import { abortableSleep, executeCode } from "../src/runtime/execute.ts";
import { isTerminal, type Job, JobQueue } from "../src/runtime/jobs.ts";
import { serialize } from "../src/runtime/serialize.ts";
import { SharedStore } from "../src/runtime/state.ts";

const input = (code: string, timeoutMs = 1000) => ({
  botId: "test",
  code,
  lang: "js" as const,
  timeoutMs,
  ifBusy: "queue" as const,
});
async function terminal(queue: JobQueue, id: string) {
  const deadline = Date.now() + 2000;
  while (!isTerminal(queue.get(id))) {
    if (Date.now() > deadline) throw new Error("Test job did not complete");
    await Bun.sleep(5);
  }
  return queue.get(id);
}

describe("execution", () => {
  test("await, return, injected globals and TypeScript survive transpilation", async () => {
    const state = { count: 0 };
    expect(
      await executeCode(
        "const n: number = await Promise.resolve(4); state.count += n; return state.count;",
        "ts",
        { state },
        "test",
      ),
    ).toBe(4);
    expect(
      await executeCode("return state.count", "js", { state }, "test2"),
    ).toBe(4);
    expect(
      await executeCode("return typeof sourceId", "js", {}, "private"),
    ).toBe("undefined");
  });
  test("syntax and runtime errors propagate", async () => {
    expect(executeCode("const =", "js", {}, "invalid")).rejects.toThrow();
    expect(
      executeCode("throw new Error('broken')", "js", {}, "broken"),
    ).rejects.toThrow("broken");
  });
});

describe("serialization", () => {
  test("projects coordinates and repeated references", () => {
    const v = new Vec3(1, 2, 3);
    expect(serialize({ a: v, b: v })).toEqual({
      a: { x: 1, y: 2, z: 3 },
      b: { x: 1, y: 2, z: 3 },
    });
  });
  test("rejects cycles, excessive results, unsupported values and accessors", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => serialize(cyclic)).toThrow("Circular");
    expect(() => serialize("abcdef", 3)).toThrow("exceeds");
    expect(() => serialize(1n)).toThrow("Unsupported");
    expect(() => serialize(Number.POSITIVE_INFINITY)).toThrow("Nonfinite");
    expect(() =>
      serialize({
        get dangerous() {
          throw new Error("getter invoked");
        },
      }),
    ).toThrow("Accessor");
  });
});

describe("shared coordination", () => {
  test("revision conflicts and deletion avoid ABA updates", () => {
    const store = new SharedStore();
    expect(store.get("x")).toEqual({ value: null, revision: 0 });
    store.set("x", { a: 1 }, { expectedRevision: 0 });
    expect(() => store.set("x", 2, { expectedRevision: 0 })).toThrow("changed");
    store.delete("x", { expectedRevision: 1 });
    expect(() => store.set("x", 3, { expectedRevision: 0 })).toThrow("changed");
    expect(store.get("x").revision).toBe(2);
  });
  test("lease tokens prevent another job from releasing a claim", () => {
    const store = new SharedStore();
    const lease = store.claim("chest", { owner: "job1", ttlMs: 1000 });
    expect(() => store.claim("chest", { owner: "job2", ttlMs: 1000 })).toThrow(
      "claimed",
    );
    expect(() => store.release("chest", "wrong")).toThrow();
    store.release("chest", lease.token);
    store.claim("chest", { owner: "job2", ttlMs: 1000 });
    store.releaseOwner("job2");
    expect(store.claim("chest", { owner: "job3", ttlMs: 1000 }).owner).toBe(
      "job3",
    );
  });
});

describe("jobs", () => {
  function queue(grace = 20) {
    let quarantined = false;
    const order: string[] = [];
    const changes: Job[] = [];
    const q = new JobQueue(
      "test",
      1,
      {
        execute: (i, signal) =>
          executeCode(
            i.code,
            i.lang,
            { sleep: (ms: number) => abortableSleep(ms, signal), order },
            "job",
          ),
        cleanup: () => {},
        quarantine: () => {
          quarantined = true;
        },
        changed: (job) => changes.push(structuredClone(job)),
      },
      grace,
      1000,
    );
    return { q, order, changes, quarantined: () => quarantined };
  }
  test("serializes same-bot work and cancels queued work without running it", async () => {
    const { q, order } = queue();
    const first = q.submit(
      input(
        "order.push('start'); await sleep(30); order.push('end'); return 1",
      ),
    );
    const canceled = q.submit(input("order.push('must-not-run')"));
    const last = q.submit(input("order.push('last'); return 3"));
    q.cancel(canceled.id);
    expect((await terminal(q, first.id)).result).toBe(1);
    expect((await terminal(q, last.id)).result).toBe(3);
    expect(order).toEqual(["start", "end", "last"]);
    expect(q.get(canceled.id).state).toBe("canceled");
  });
  test("cooperative timeouts release queue; next job runs", async () => {
    const { q, quarantined } = queue();
    const job = q.submit(input("await sleep(1000)", 10));
    const next = q.submit(input("return 'ok'"));
    expect((await terminal(q, job.id)).state).toBe("timed_out");
    expect((await terminal(q, next.id)).result).toBe("ok");
    expect(quarantined()).toBe(false);
  });
  test("noncooperative promises quarantine the bot and interrupt queued jobs", async () => {
    const { q, quarantined } = queue();
    const job = q.submit(input("await new Promise(() => {})", 10));
    const next = q.submit(input("return 'never'"));
    expect((await terminal(q, job.id)).state).toBe("timed_out");
    expect(q.get(next.id).state).toBe("interrupted");
    expect(quarantined()).toBe(true);
    expect(() => q.submit(input("return 1"))).toThrow("Reconnect");
  });
  test("jobs on separate bots progress concurrently", async () => {
    const a = queue();
    const b = queue();
    const ja = a.q.submit(input("await sleep(50); return 1"));
    const jb = b.q.submit(input("return 2"));
    expect((await terminal(b.q, jb.id)).result).toBe(2);
    expect(a.q.get(ja.id).state).toBe("running");
    await terminal(a.q, ja.id);
  });
  test("serialization errors do not wedge the execution queue", async () => {
    const { q } = queue();
    const a = q.submit(input("return { f() {} }"));
    const b = q.submit(input("return 2"));
    expect((await terminal(q, a.id)).error?.code).toBe("SERIALIZATION_ERROR");
    expect((await terminal(q, b.id)).result).toBe(2);
  });
});

describe("protocol history", () => {
  test("deduplicates concurrent requests and detects ID collisions", async () => {
    const cache = new Deduplicator<number>(1);
    let runs = 0;
    const run = async () => ++runs;
    const [a, b] = await Promise.all([
      cache.run("a", "payload", run),
      cache.run("a", "payload", run),
    ]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
    expect(() => cache.run("a", "different", run)).toThrow("different payload");
    expect(() => cache.run("b", "payload", run)).toThrow("full");
  });
  test("event cursors detect overwritten history and other daemon lifetimes", () => {
    const events = new EventBuffer("daemon", "bot", 2);
    const first = events.push("a", {}, 1);
    events.push("b", {}, 1);
    events.push("c", {}, 2);
    events.push("d", {}, 2);
    expect(() => events.read(first)).toThrow("Oldest");
    expect(() => events.read("other:bot:1")).toThrow("another");
    expect(events.read().events.map((e) => e.type)).toEqual(["c", "d"]);
  });
});
