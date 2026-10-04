import type { Envelope } from "./protocol.ts";
import type { Job, JobSummary } from "./runtime/jobs.ts";

export type OutputKind = "data" | "job" | "jobs" | "fleet";

function compactJob(job: Job | JobSummary) {
  return {
    id: job.id,
    botId: job.botId,
    generation: job.generation,
    state: job.state,
    ...("result" in job ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...("logs" in job && job.logs.length ? { logs: job.logs } : {}),
  };
}

// Project only known command records, never objects inside a user's result.
export function compactEnvelope(
  envelope: Envelope,
  kind: OutputKind = "data",
): { ok: boolean; data?: unknown; error?: Envelope["error"] } {
  let data = envelope.data;
  if (data !== undefined) {
    if (kind === "job") data = compactJob(data as Job);
    else if (kind === "jobs") data = (data as JobSummary[]).map(compactJob);
    else if (kind === "fleet")
      data = Object.fromEntries(
        Object.entries(data as Record<string, Envelope>).map(([id, result]) => [
          id,
          compactEnvelope(result, "job"),
        ]),
      );
  }
  return {
    ok: envelope.ok,
    ...(data !== undefined ? { data } : {}),
    ...(envelope.error ? { error: envelope.error } : {}),
  };
}
