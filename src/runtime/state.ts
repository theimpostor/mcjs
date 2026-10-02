import { McjsError } from "../errors.ts";
import { type JsonValue, serialize } from "./serialize.ts";

export class SharedStore {
  private values = new Map<string, { value: JsonValue; revision: number }>();
  private revisions = new Map<string, number>();
  private leases = new Map<
    string,
    { owner: string; token: string; expiresAt: number }
  >();
  get(key: string) {
    const entry = this.values.get(key);
    return entry
      ? structuredClone(entry)
      : { value: null, revision: this.revisions.get(key) ?? 0 };
  }
  set(key: string, value: unknown, options: { expectedRevision: number }) {
    if (this.get(key).revision !== options.expectedRevision)
      throw new McjsError(
        "REVISION_CONFLICT",
        `Shared value changed: ${key}`,
        true,
      );
    const revision = options.expectedRevision + 1;
    this.values.set(key, { value: serialize(value), revision });
    this.revisions.set(key, revision);
    return this.get(key);
  }
  delete(key: string, options: { expectedRevision: number }) {
    this.set(key, null, options);
    this.values.delete(key);
    return this.get(key);
  }
  claim(key: string, options: { owner: string; ttlMs: number }) {
    if (!(options.ttlMs > 0 && options.ttlMs <= 300_000))
      throw new McjsError("INVALID_ARGUMENT", "Lease TTL must be 1..300000 ms");
    const existing = this.leases.get(key);
    if (existing && existing.expiresAt > Date.now())
      throw new McjsError("RESOURCE_BUSY", `Resource claimed: ${key}`, true);
    const lease = {
      owner: options.owner,
      token: crypto.randomUUID(),
      expiresAt: Date.now() + options.ttlMs,
    };
    this.leases.set(key, lease);
    return { ...lease };
  }
  renew(key: string, token: string, ttlMs: number) {
    const lease = this.leases.get(key);
    if (!lease || lease.token !== token || lease.expiresAt <= Date.now())
      throw new McjsError("LEASE_EXPIRED", key);
    if (!(ttlMs > 0 && ttlMs <= 300_000))
      throw new McjsError("INVALID_ARGUMENT", "Invalid lease TTL");
    lease.expiresAt = Date.now() + ttlMs;
    return { ...lease };
  }
  release(key: string, token: string) {
    if (this.leases.get(key)?.token !== token)
      throw new McjsError("LEASE_MISMATCH", key);
    this.leases.delete(key);
  }
  releaseOwner(owner: string) {
    for (const [key, lease] of this.leases)
      if (lease.owner === owner) this.leases.delete(key);
  }
}
