# Execution and jobs

`mcjs exec scout 'return bot.health'` queues and waits for a job. Use --background
for long work, --timeout-ms to set its execution deadline, and --wait-ms to limit
only CLI waiting. Use --stdin with a quoted heredoc, or --file script.ts, for
multiline code. --lang ts enables TypeScript for inline/stdin programs.

The program is an async function body, not a module. Top-level await and return
work; static import/export do not. Dynamic import() is available for installed
packages. TypeScript is transpiled, not type-checked at execution time. `log`
and console.log/info/warn/error/debug append bounded job logs. Return compact
JSON objects. Vec3, Item, Block and Entity values receive compact projections.
Functions, BigInt, nonfinite numbers and cyclic objects are rejected.

`botState` is a persistent in-memory JSON object per bot. `shared` is a store
with revisions and leases. Globals include `signal`, an AbortSignal, and
`helpers.checkpoint()` / `helpers.sleep(ms)` for cooperative cancellation.
Navigation and collection helpers check cancellation around Mineflayer awaits.

One job executes per bot. Other bots run concurrently. Use built-in bot snapshot,
info and events to observe during a long job; another exec queues behind it.

`mcjs job get <id>` returns state/result/error/logs; job wait polls; job cancel
aborts; bot stop cancels pending work and clears plugin controls. Always inspect
the job state, including when RPC ok is true. Deadline expiration does not kill
arbitrary JavaScript. After cancellation, nonsettling code quarantines the bot.
Do not immediately resubmit after a transport error: inspect jobs first.

Directly created listeners/timers are your responsibility: clean them up with
try/finally. Keep follow/combat behavior inside a background job, then stop it in
finally. Do not start a persistent action and immediately return.
