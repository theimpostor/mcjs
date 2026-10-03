import { z } from "zod";

export const VERSION = "0.1.0";
export const PROTOCOL = 1;
export const MAX_RESULT_BYTES = 1024 * 1024;
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_LOG_ENTRY_BYTES = 64 * 1024;
export const MAX_RPC_RESPONSE_BYTES = MAX_RESULT_BYTES;
export const MAX_JOB_RESPONSE_BYTES =
  MAX_RESULT_BYTES + MAX_LOG_BYTES + 64 * 1024;
export const MAX_EVENT_RESPONSE_BYTES = MAX_RPC_RESPONSE_BYTES;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
export const botConfigSchema = z
  .object({
    id: idSchema,
    host: z.string().min(1).default("localhost"),
    port: z.number().int().min(1).max(65535).default(25565),
    username: z.string().min(1),
    auth: z.enum(["offline", "microsoft"]).default("offline"),
    version: z.string().min(1).optional(),
    plugins: z
      .array(z.enum(["pathfinder", "tool", "collectblock", "pvp"]))
      .default(["pathfinder", "tool", "collectblock"]),
  })
  .strict();
export type BotConfig = z.infer<typeof botConfigSchema>;

export const execSchema = z
  .object({
    botId: idSchema,
    code: z
      .string()
      .min(1)
      .refine(
        (v) => Buffer.byteLength(v) <= 256 * 1024,
        "Code exceeds 256 KiB",
      ),
    lang: z.enum(["js", "ts"]).default("js"),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(30_000),
    ifBusy: z.enum(["queue", "reject"]).default("queue"),
  })
  .strict();
export type ExecInput = z.infer<typeof execSchema>;

export const requestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL),
    requestId: z.uuid(),
    method: z.string().min(1),
    params: z.unknown(),
  })
  .strict();
export type RpcRequest = z.infer<typeof requestSchema>;
export interface Envelope<T = unknown> {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
  meta: { daemonId: string; durationMs: number };
}
