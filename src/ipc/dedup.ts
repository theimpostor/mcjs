import { McjsError } from "../errors.ts";

export class Deduplicator<T> {
  private entries = new Map<
    string,
    { fingerprint: string; expiresAt: number; result: Promise<T> }
  >();
  constructor(
    private limit = 10_000,
    private ttlMs = 600_000,
  ) {}
  run(id: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
    for (const [key, value] of this.entries)
      if (value.expiresAt <= Date.now()) this.entries.delete(key);
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new McjsError(
          "REQUEST_ID_CONFLICT",
          "Request ID reused with a different payload",
        );
      return existing.result;
    }
    if (this.entries.size >= this.limit)
      throw new McjsError(
        "REQUEST_CACHE_FULL",
        "Retry cache is full; retry later",
        true,
      );
    const result = Promise.resolve().then(action);
    this.entries.set(id, {
      fingerprint,
      expiresAt: Date.now() + this.ttlMs,
      result,
    });
    return result;
  }
}
