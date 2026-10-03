# Multiple bots and shared state

Create named bots with unique identities. `exec-many scout,builder '<code>'` or
`exec-all '<code>'` submits separate jobs. Each executes with its own bot and
botState. Fleet results preserve successes and failures independently; there is
no transaction or rollback. exec-all snapshots ready bot IDs when it starts.
Submission concurrency is bounded, but waiting for job completion does not hold
up submission to the remaining bots.

Use shared.get(key) to read {value, revision}. To update:

```js
const old = shared.get('overworld:base');
shared.set('overworld:base', {x: 100, y: 64, z: 20}, {
  expectedRevision: old.revision
});
```

A conflicting revision fails. Reread and reason about the new value before retry.
Namespace resource keys by server/world/dimension when coordinating multiple worlds.

Claim a resource while a job works on it:

```js
const key = 'server1:overworld:chest:100,64,20';
const lease = shared.claim(key, {ttlMs: 30000});
try {
  // Perform a bounded container operation; renew before expiry if needed.
  return helpers.snapshot();
} finally {
  shared.release(key, lease.token);
}
```

Claims are owned by the current job and released on job termination. Cancellation
keeps claims during cooperative cleanup, until the execution settles or its
cancellation grace period ends; explicit release and TTL expiry still apply.
The token is needed to renew or release a lease. TTL is 1..300000 ms. Cooperative
leases do not stop other Minecraft players from using the same resource. All
state is in memory and is lost on daemon restart; bot reconnect preserves botState.
