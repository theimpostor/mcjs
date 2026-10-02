import { errorData, McjsError } from "../errors.ts";
import type { ExecInput } from "../protocol.ts";
import { type JsonValue, serialize } from "./serialize.ts";

export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out"
  | "interrupted";
export interface Job {
  id: string;
  botId: string;
  generation: number;
  state: JobState;
  sourceHash: string;
  submittedAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: JsonValue;
  error?: ReturnType<typeof errorData>;
  logs: JsonValue[];
}
interface Work {
  job: Job;
  input: ExecInput;
  abort: AbortController;
  queueTimer?: ReturnType<typeof setTimeout>;
  logBytes: number;
}
export interface ExecutionHooks {
  execute: (
    input: ExecInput,
    signal: AbortSignal,
    log: (...values: unknown[]) => void,
    jobId: string,
  ) => Promise<unknown>;
  cleanup: (jobId: string) => void;
  quarantine: () => void;
  changed: (job: Job) => void;
}
export function isTerminal(job: Pick<Job, "state">) {
  return job.state !== "queued" && job.state !== "running";
}

export class JobQueue {
  private jobs = new Map<string, Work>();
  private queue: Work[] = [];
  private active: Work | undefined;
  private blocked = false;
  constructor(
    private botId: string,
    private generation: number,
    private hooks: ExecutionHooks,
    private graceMs = 2_000,
    private queueTimeoutMs = 60_000,
  ) {}
  get busy() {
    return this.active !== undefined;
  }
  submit(input: ExecInput) {
    if (this.blocked)
      throw new McjsError(
        "BOT_UNAVAILABLE",
        "Reconnect bot before submitting work",
      );
    if (this.active && input.ifBusy === "reject")
      throw new McjsError("BOT_BUSY", this.botId, true);
    if (this.queue.length >= 32)
      throw new McjsError("QUEUE_FULL", this.botId, true);
    this.prune();
    const job: Job = {
      id: crypto.randomUUID(),
      botId: this.botId,
      generation: this.generation,
      state: "queued",
      sourceHash: new Bun.CryptoHasher("sha256")
        .update(input.code)
        .digest("hex"),
      submittedAt: Date.now(),
      logs: [],
    };
    const work: Work = {
      job,
      input,
      abort: new AbortController(),
      logBytes: 0,
    };
    this.jobs.set(job.id, work);
    this.queue.push(work);
    work.queueTimer = setTimeout(() => {
      if (job.state === "queued") {
        this.queue = this.queue.filter((w) => w !== work);
        this.finish(
          work,
          "timed_out",
          new McjsError("QUEUE_TIMEOUT", "Queue wait exceeded deadline"),
        );
      }
    }, this.queueTimeoutMs);
    this.hooks.changed(job);
    void this.drain();
    return this.get(job.id);
  }
  get(id: string): Job {
    const work = this.jobs.get(id);
    if (!work) throw new McjsError("JOB_NOT_FOUND", id);
    return structuredClone(work.job);
  }
  list() {
    return [...this.jobs.values()].map((w) => structuredClone(w.job));
  }
  cancel(id: string) {
    const work = this.jobs.get(id);
    if (!work) throw new McjsError("JOB_NOT_FOUND", id);
    if (isTerminal(work.job)) return this.get(id);
    if (work.job.state === "queued") {
      this.queue = this.queue.filter((w) => w !== work);
      this.finish(work, "canceled", new McjsError("CANCELED", "Job canceled"));
    } else work.abort.abort(new McjsError("CANCELED", "Job canceled"));
    return this.get(id);
  }
  interrupt(reason = "Bot disconnected") {
    this.blocked = true;
    for (const work of this.queue.splice(0))
      this.finish(work, "interrupted", new McjsError("INTERRUPTED", reason));
    this.active?.abort.abort(new McjsError("INTERRUPTED", reason));
  }
  private finish(work: Work, state: JobState, error?: unknown) {
    clearTimeout(work.queueTimer);
    work.job.state = state;
    work.job.endedAt = Date.now();
    if (error !== undefined) work.job.error = errorData(error);
    this.hooks.changed(work.job);
  }
  private prune() {
    const completed = [...this.jobs.values()].filter((w) => isTerminal(w.job));
    for (const [i, work] of completed.entries()) {
      if (
        (work.job.endedAt ?? 0) < Date.now() - 3_600_000 ||
        i < completed.length - 999
      )
        this.jobs.delete(work.job.id);
    }
  }
  private async drain() {
    if (this.active || this.blocked) return;
    const work = this.queue.shift();
    if (!work) return;
    this.active = work;
    clearTimeout(work.queueTimer);
    work.job.state = "running";
    work.job.startedAt = Date.now();
    this.hooks.changed(work.job);
    const deadline = setTimeout(
      () =>
        work.abort.abort(
          new McjsError("DEADLINE_EXCEEDED", "Execution deadline exceeded"),
        ),
      work.input.timeoutMs,
    );
    let settled = false;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<{ kind: "abort" }>((resolve) => {
      abortListener = () => resolve({ kind: "abort" });
      work.abort.signal.addEventListener("abort", abortListener, {
        once: true,
      });
    });
    const execution = Promise.resolve()
      .then(() =>
        this.hooks.execute(
          work.input,
          work.abort.signal,
          (...values) => {
            if (isTerminal(work.job)) return;
            const data = serialize(values, 64 * 1024);
            const bytes = Buffer.byteLength(JSON.stringify(data));
            if (work.logBytes + bytes <= 256 * 1024) {
              work.job.logs.push(data);
              work.logBytes += bytes;
            }
          },
          work.job.id,
        ),
      )
      .then(
        (value) => {
          settled = true;
          return { kind: "value" as const, value };
        },
        (error) => {
          settled = true;
          return { kind: "error" as const, error };
        },
      );
    try {
      const outcome = await Promise.race([execution, aborted]);
      if (work.abort.signal.aborted || outcome.kind === "abort") {
        this.hooks.cleanup(work.job.id);
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          execution,
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, this.graceMs);
          }),
        ]);
        clearTimeout(grace);
        if (!settled) {
          this.interrupt(
            "Previous execution did not settle after cancellation",
          );
          this.hooks.quarantine();
        }
        const reason = work.abort.signal.reason;
        const code = errorData(reason).code;
        this.finish(
          work,
          code === "DEADLINE_EXCEEDED"
            ? "timed_out"
            : code === "INTERRUPTED"
              ? "interrupted"
              : "canceled",
          reason,
        );
      } else if (outcome.kind === "error")
        this.finish(work, "failed", outcome.error);
      else {
        work.job.result = serialize(outcome.value);
        this.finish(work, "succeeded");
      }
    } catch (error) {
      this.finish(work, "failed", error);
    } finally {
      clearTimeout(deadline);
      if (abortListener)
        work.abort.signal.removeEventListener("abort", abortListener);
      this.hooks.cleanup(work.job.id);
      this.active = undefined;
      void this.drain();
    }
  }
}
