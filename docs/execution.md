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
Other class instances, such as Recipe, need an explicit plain JSON projection.
For large scans return a count and a bounded sample, storing coordinates in
botState if a later call needs the full set. Output limits are ceilings, not targets.
The serialized return value may be up to 1 MiB, with up to 256 KiB of retained
log entries. Job retrieval includes room for both budgets and record metadata.

Use --compact on exec, job get/wait/cancel and jobs list for routine observation.
It keeps {ok,data,error}, omits transport metadata, and removes job source hashes,
timestamps and empty logs. IDs, bot generation, state, result, errors and nonempty
logs remain intact, including per-bot fleet outcomes. User result objects are
never trimmed. Omit --compact to retrieve the complete records for diagnosis.

In standalone builds, use the injected `Vec3`, `mcData`, `goals`, `Movements` and
`bot` globals to access bundled libraries. Bundling does not install packages for
dynamic imports by package name (for example, `import('vec3')`). Additional
libraries must be provided separately.

`botState` is a persistent in-memory JSON object per bot. `shared` is a store
with revisions and leases. Globals include `signal`, an AbortSignal, and
`helpers.checkpoint()` / `helpers.sleep(ms)` for cooperative cancellation.
Navigation and collection helpers check cancellation around Mineflayer awaits.

One job executes per bot. Other bots run concurrently. Use built-in bot snapshot,
info and events to observe during a long job; another exec queues behind it.
This includes chat-only exec calls. Update botState.progress during long loops
and use state get for compact progress without queueing another program.
Use job wait --wait-ms 10000 for a bounded wait, or events --types job --follow
and fetch the result after the job reaches a terminal state.

`mcjs job get <id>` returns state/result/error/logs; job wait polls; job cancel
aborts; bot stop cancels pending work and clears plugin controls. Always inspect
the job state, including when RPC ok is true. Deadline expiration does not kill
arbitrary JavaScript. After cancellation, nonsettling code quarantines the bot.
Respawning does not clear quarantine; use an explicit bot reconnect or remove.
Do not immediately resubmit after a transport error: inspect jobs first.

Directly created listeners/timers are your responsibility: clean them up with
try/finally. Keep follow/combat behavior inside a background job, then stop it in
finally. Do not start a persistent action and immediately return.
daemon stop shuts down the daemon process, including remaining timers. If
synchronous code freezes its event loop, terminate the daemon externally.
