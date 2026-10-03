# mcjs implementation specification

Draft implementation contract • 1 October 2026

mcjs is a local programmable interface to Minecraft Java Edition for coding agents. An agent invokes a short-lived CLI, which submits JavaScript or TypeScript to a persistent Bun daemon containing named Mineflayer bots. The daemon maintains connections, runs programs, tracks jobs and events, and exposes documentation. The coding agent supplies reasoning; mcjs supplies execution and observation. “Code mode” describes the code accepted by the CLI, not a separate agent runtime or an MCP requirement.

This document defines the first release and its acceptance criteria. Normative requirements use MUST or SHOULD. Defaults below are proposed product decisions, not upstream guarantees.

## Goals and scope

The first release MUST support multiple bots on one or several servers, asynchronous programs against the real Mineflayer API, per-bot memory, coordinated shared memory, compact JSON results, background jobs, cancellation, event history, local API discovery, and a loadable agent skill.

Implement in strict TypeScript using Bun for runtime, package management, IPC, subprocess launch, files, transpilation, and tests. Use Biome for linting and formatting. Minecraft Java is the target; Bedrock, autonomous model integration, an MCP adapter, a web control dashboard, and distributed daemon orchestration are outside the first release. An optional browser viewer is included for watching bots.

The initial supported hosts are Linux and macOS. Windows users can run the daemon in WSL2; document how to reach a Minecraft server on the Windows host. Native Windows IPC is a later transport adapter, not an assumed Unix-socket feature. Online authentication remains supported on initial platforms.

## Dependencies and version policy

Use the latest stable npm release of Mineflayer at implementation kickoff. The upstream release page and npm listing currently identify **4.39.0** as latest. Recheck before implementation; install the selected stable version exactly and commit `bun.lock`. Never depend on a floating `latest` tag in a release artifact. Upgrade through reviewed lockfile changes and compatibility tests.

Select current stable Bun, TypeScript, `@types/bun`, and `@biomejs/biome` at kickoff and record their exact versions. Pin the Bun version in CI and package metadata. Run `tsc --noEmit`: Bun's TypeScript execution does not replace type checking. Use a small schema validator such as Zod for all IPC requests and persisted JSON.

Mineflayer is a Node-oriented library. Bun execution is a project compatibility requirement to prove, not an upstream support claim. Before building the main interface, verify connection, physics, inventory, digging, pathfinding, disconnect, authentication, and chosen plugins under Bun. A failure is a release blocker; document any dependency patch. Do not silently substitute a Node daemon.

| Package | Initial policy | Purpose |
| --- | --- | --- |
| `mineflayer` | Required | Bot and Minecraft protocol integration |
| `minecraft-data`, `vec3` | Required | Version-aware registries and coordinates |
| `mineflayer-pathfinder` | Enabled by default | Navigation, goals, movements |
| `mineflayer-tool` | Enabled by default | Tool selection |
| `mineflayer-collectblock` | Enabled by default | Gathering blocks and drops |
| `mineflayer-pvp` | Installed, opt-in | Combat control |
| `mineflayer-armor-manager` | Candidate, opt-in after validation | Armor management |
| `prismarine-viewer` | Optional installation/profile | Browser observation |

These are established ecosystem candidates, not a promise that every plugin supports every Minecraft release or Bun. Resolve plugin dependencies and load them once in topological order. In particular, collection depends on pathfinding and tool selection; combat requires pathfinding. Verify each package's current exports, types, and dependencies. Do not load competing autonomous movement controllers by default.

Each plugin adapter MUST declare its ID, package/version, dependencies, load function, API namespaces, bundled docs, and stop/cleanup hooks. `bot info` reports requested and actually loaded plugins, including failures. Unknown plugins fail validation. Arbitrary dynamic package installation and hot reloading are deferred; trusted users can still import installed libraries in submitted code.

## Architecture and lifetime

One daemon owns a `Map<BotId, BotSession>`, a job registry, a shared JSON state store, and bounded event buffers. Each session owns its Mineflayer instance, bot generation, queue, persistent-in-memory state, plugin adapters, and runtime metadata. Different bots execute concurrently; each bot has one active execution slot by default.

The CLI is a client, never the owner of the Minecraft connection. Closing the terminal or ending a CLI call does not disconnect bots. Daemon shutdown cancels jobs, stops plugin activity, closes viewers and bots, flushes configured persistence, then removes only its own IPC endpoint.

A single-process bot manager is the first-release choice because it provides direct Mineflayer objects without inventing a remote API for every method. Consequently, a synchronous infinite loop in submitted code can freeze all bots. Trusted arbitrary code is not sandboxed. Per-bot child-process isolation is a later alternative with different shared-state semantics.

## Bun IPC and daemon management

Use **HTTP over a Unix-domain socket**, implemented with `Bun.serve({ unix, fetch })`; the CLI uses Bun `fetch` with its `unix` option. This gives Bun-native IPC, request validation, and streaming responses without writing custom frame parsing. Do not also implement raw `Bun.listen` framing in version one.

Default endpoint: `$XDG_RUNTIME_DIR/mcjs/<profile>/daemon.sock` where available; otherwise an owner-only per-user runtime directory under the OS temporary directory. Keep paths short enough for Unix socket limits. Profiles match `[a-z0-9][a-z0-9_-]{0,47}` and namespace daemon, socket, config and state. Directory mode MUST be 0700 and socket mode 0600 before accepting requests. Use a random daemon token in a 0600 file and a bearer header as defense in depth; never print the token.

Explicit `daemon start` is idempotent when a compatible daemon is healthy. `bot create` may autostart; other commands fail clearly if no daemon exists. Launch using `Bun.spawn`, redirect daemon logs to an owner-only file, and wait for a readiness handshake rather than a fixed sleep. A start lock MUST prevent simultaneous clients launching competing daemons; retry health after acquiring the lock. Verify identity and liveness before removing a stale socket. Never unlink an unknown endpoint solely because a health request failed.

The handshake returns protocol major/minor, daemon instance ID, mcjs version, Bun version, PID and capabilities. Major mismatch fails with upgrade guidance. `doctor` checks socket permissions, dependency versions, daemon health and known compatibility failures. Endpoint override is explicit; there is no default TCP eval listener.

### Protocol

All mutating requests carry `protocolVersion`, `requestId`, `method`, and validated `params`. Request IDs are client-generated UUIDs. The daemon retains deduplication records for ten minutes, with a maximum of 10,000; when full, reject new mutations rather than evict unexpired records. Same ID and same payload returns the original job or receipt; same ID with different payload fails. This prevents common transport retries from executing a job twice within one daemon lifetime. Across restart, outcome may be unknown and the CLI MUST not automatically resubmit code.

Responses use this envelope:

```ts
interface ResponseEnvelope<T> {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable: boolean;
  };
  meta: { daemonId: string; durationMs: number };
}
```

Representative endpoints: `GET /v1/status`, `POST /v1/rpc`, and `GET /v1/events` for NDJSON streaming. Domain methods include `bot.create`, `bot.remove`, `exec.submit`, `job.get`, `job.cancel`, `state.get`, and `state.set`. Validate content type, body length, authentication and protocol before dispatch. Default request limit is 1 MiB, code limit 256 KiB, serialized result limit 1 MiB, and bounded log retention of 256 KiB per job. Reject oversized results with `RESULT_TOO_LARGE`; do not return malformed or silently truncated JSON.

## CLI contract

JSON is the default. A normal command writes exactly one JSON envelope to stdout. `events --follow` writes NDJSON. Diagnostic and authentication instructions go to stderr; plugin logging MUST never corrupt stdout. `--human` enables readable summaries. Global options include `--profile`, `--socket`, and `--human`.

| Command | Behavior |
| --- | --- |
| `mcjs daemon start\|status\|stop` | Manage persistent daemon |
| `mcjs doctor` | Diagnose runtime and compatibility |
| `mcjs bot create <id> [options]` | Connect and wait for readiness or return an explicit connection job |
| `mcjs bot list` / `bot info <id>` | Sessions, lifecycle, capabilities, jobs, viewer URLs |
| `mcjs bot remove <id>` | Cancel work, disconnect, destroy session |
| `mcjs bot reconnect <id>` | Reconnect same config with a new generation |
| `mcjs bot stop <id>` | Emergency stop of job and plugin controls |
| `mcjs exec <id> <code>` | Submit code and await completion by default |
| `mcjs exec <id> --file <path>` / `--stdin` | Submit source without shell escaping |
| `mcjs exec-many <id,id> <code>` | Independent per-bot executions |
| `mcjs exec-all <code>` | Snapshot current ready bot IDs, then execute independently |
| `mcjs jobs list` / `job get\|wait\|cancel <id>` | Manage background work |
| `mcjs inspect <id> <path>` | Describe allowlisted live object namespaces |
| `mcjs docs [topic]` | Read bundled API documentation without a daemon |
| `mcjs events [id] --since <cursor> [--follow]` | Read or stream normalized events |
| `mcjs state get\|set <id> ...` | Read or replace JSON bot memory |
| `mcjs shared get\|set <key> ...` | Read or compare-and-set shared values |
| `mcjs viewer start\|stop <id>` | Control optional loopback viewer |
| `mcjs skill path` / `skill print` | Locate or emit bundled SKILL.md |
| `mcjs skill install --dir <path>` | Copy bundled skill into an explicit agent skill root |

`bot create` options include `--host` (default localhost), `--port` (25565), required `--username`, `--auth offline|microsoft` (default offline), optional `--version`, and `--plugins <list>`. IDs are unique per profile; duplicate create fails unless it is an identical retried request. Use `--auth microsoft` for online-mode servers. Never log access tokens or copy authentication caches into reports. Separate online bots generally require separate Minecraft-entitled accounts to stay logged in concurrently; aliases do not create accounts. Separate account caches and verify cache behavior with the selected Mineflayer release.

Exit codes: 0 success, 1 remote execution/domain failure, 2 argument/schema failure, 3 transport/unavailable daemon, 4 deadline exceeded, 5 canceled, 6 partial fleet failure. Fleet output contains every selected bot's job/result/error; one failure never discards successes. Fan-out is not transactional. Default fleet submission concurrency is four.

## Execution context and semantics

Execute a function body, not an expression or full ES module. Top-level `await` and `return` are supported. Exactly one of positional source, `--file`, or `--stdin` is required. JavaScript is the default; `--lang ts` and `.ts` file inference enable TypeScript. Transpile the wrapped async function with `Bun.Transpiler` before evaluation; preserve source labels and map errors back to user lines. Test this wrapper explicitly. TS syntax is accepted, but execution does not type-check snippets.

Expose injected lexical parameters:

```ts
interface ExecutionContext {
  bot: Bot;
  mcData: MinecraftData;
  Vec3: typeof Vec3;
  goals: typeof PathfinderGoals;
  Movements: typeof PathfinderMovements;
  botState: Record<string, JsonValue>;
  shared: SharedStore;
  signal: AbortSignal;
  helpers: Helpers;
  log: (...values: unknown[]) => void;
}
```

This is an illustrative contract; implementation imports the actual upstream types. `mcData` is initialized from the negotiated `bot.version`, not a global server-version assumption. Plugin APIs remain on `bot`. Bot-local lexical variables disappear after a call; `botState` persists across calls. No hidden shared lexical REPL environment exists. Expose dynamic `import()` for installed modules; do not promise CommonJS `require` unless explicitly implemented.

`botState` accepts only JSON values and is validated after completion. Helpers offer `snapshot`, abortable `sleep`, `checkpoint`, and abort-aware navigation/collection wrappers. They complement direct Mineflayer access. Submitted programs can operate directly on `bot`; cancellation of such calls is best effort. Raw APIs and arbitrary code can bypass helpers and state restrictions, so these contracts are cooperation conventions rather than security boundaries.

Plain objects, arrays, finite numbers, booleans, strings and null serialize normally; top-level undefined becomes null. Provide serializers for Vec3, Item, Block, and Entity that emit useful compact fields and omit cycles/internal clients. Dates serialize as ISO strings. Functions, promises, nonfinite numbers, BigInt and unsupported cyclic graphs fail with `SERIALIZATION_ERROR` and a field path. Execution may already have changed the world even if serialization fails. Encourage returning DTOs instead of the whole bot.

`inspect` accepts a dotted namespace path such as `bot.inventory` or `bot.pathfinder`, not arbitrary code. Enumerate data properties and prototype method names without invoking accessors. Limit depth and output size. Introspection lists names; docs supply signatures and semantics.

## Jobs, scheduling and cancellation

Every execution creates a job with ID, bot ID/generation, source hash, submitted/start/end times, state, result/error, deadline, and logs. States are `queued`, `running`, `succeeded`, `failed`, `canceled`, `timed_out`, and `interrupted`. Retain 1,000 completed jobs for one hour in memory; evict oldest completed records when needed. Active jobs are never evicted. Optional persisted history stores results and metadata, not source by default.

`exec` waits by default. `--background` immediately returns the job ID. `--wait-ms` limits only CLI waiting and returns an active job receipt when elapsed; `--timeout-ms` limits execution after it starts. Default execution deadline is 30 seconds; allow explicit longer deadlines up to one hour. Queue limit is 32 per bot, with a 60-second queue deadline. Busy submissions queue unless `--if-busy reject` is requested.

One queue includes all exec programs, including observations: mcjs cannot prove arbitrary code is read-only. Built-in status, events and snapshots remain responsive during an asynchronous job. Different bot queues run concurrently. Fleet operations enqueue independent jobs and do not acquire multiple bot locks.

Canceling a queued job removes it. Canceling an active job aborts `signal`, invokes plugin cleanup, clears controls, stops digging/use of items, and attempts to close active containers. Helpers check cancellation before and after awaits. Returning or throwing runs cleanup for job-owned listeners and timers registered through helpers. Directly created timers/listeners are the program author's responsibility.

A Promise timeout alone does not stop underlying code. If an active execution has not settled within two seconds after abort, mark its session `quarantined`, reject new execution and require `bot reconnect` or remove. Reconnect replaces the instance and generation; late callbacks and results cannot update the current session. Previously dispatched Minecraft actions cannot be undone. Arbitrary code can still retain references or consume CPU; no claim of hard cancellation is permitted. An external supervisor can kill an unresponsive daemon, which interrupts all bots and loses in-memory state.

Long-lived follow/combat behaviors must remain represented by a background job that owns their cleanup. Programs SHOULD await completion rather than start an untracked goal and return. Emergency `bot stop` also invokes adapter cleanup for untracked plugin activity.

## Bot lifecycle and recovery

Lifecycle: `connecting`, `auth_required`, `ready`, `disconnected`, `quarantined`, `removing`, `removed`, or `failed`. Connection readiness requires spawn and required plugin initialization. Default spawn deadline is 30 seconds, separate from interactive authentication time; authentication may wait up to five minutes and emits a sanitized auth-required event and stderr instructions.

Install error, kick and end handlers immediately. Death emits an event; allow normal Mineflayer respawn but cancel active work and increment world-generation metadata on respawn or dimension change so scripts cannot silently continue against stale assumptions. A disconnect interrupts active jobs and fails queued jobs. Default automatic reconnect is off; opt-in reconnection uses bounded exponential backoff and never replays code or resumes a partially completed world action.

`bot remove` is idempotent for already removed IDs, with an explicit receipt. Bot definitions may be saved, but daemon restart does not connect accounts without explicit start/create or a configured `--restore` action.

## Bot state and fleet coordination

Bot memory persists in process across executions and ordinary reconnects, but world references are never persisted. JSON state includes a schema version. Disk persistence is opt-in with atomic temporary-file rename through Bun file APIs; use owner-only directories and files. Persist config, approved JSON state and optional job history, never live entities, listeners, functions or raw auth tokens. A daemon crash loses changes since the last completed checkpoint.

Avoid a mutable global `sharedState` object. Concurrent asynchronous jobs can lose updates. Provide daemon-owned `shared.get(key)` returning `{value, revision}`, `shared.set(key, value, {expectedRevision})`, and `shared.delete(key, {expectedRevision})`. Revision conflicts fail explicitly; operations are synchronous and atomic within the daemon event loop. Keys are scoped by profile and optional server namespace so coordinates from different worlds are not accidentally mixed.

Provide renewable leases through `shared.claim(key, {owner, ttlMs})`, `shared.renew`, and `shared.release`. Claims return an opaque lease token required for renewal/release. TTL expiry and job termination release claims. These coordinate cooperative workers; they do not physically prevent another Minecraft player from touching a chest or block. Document resource keys for build regions, chests, and work assignments.

## Observation and events

Maintain a bounded ring of 10,000 events per bot. Each event includes daemon ID, bot ID, bot generation, sequence, timestamp, type, and compact JSON payload. Types cover lifecycle, chat, health/food, death/respawn, dimension, job progress, plugin failure and selected inventory/navigation changes. Avoid per-tick position spam; snapshot position on demand and coalesce high-frequency updates.

Cursors encode daemon ID, bot ID and sequence. A cursor from a different daemon returns `CURSOR_INVALID`; overwritten history returns `CURSOR_EXPIRED` with the oldest available cursor. Fleet streams identify bot IDs; no universal cross-bot chronological guarantee is implied. Filtering never changes cursor advancement semantics. Slow stream consumers have bounded queues and are disconnected with a recoverable cursor rather than allowing unbounded memory growth.

Chat, kick reasons, server messages and player-provided text MUST be labeled untrusted in DTOs and skill instructions. They never execute code automatically. `helpers.snapshot()` returns position, dimension, health, food, inventory summary, nearby entities, current job and loaded plugins with configurable distance and entity limits. Classification of hostile entities uses explicit version-aware names/rules, not `entity.type === 'mob'` alone. World searches only see loaded chunks; they are not a global map or a guarantee of locating distant villages.

## Documentation and agent skill

Ship `skills/mcjs/SKILL.md`, topic references, and examples with the package. This specification defines the deliverable; it does not install a new skill into the user's account. `skill install --dir` writes only to the explicit destination, refuses overwrite by default, and supports an explicit force option. Use a portable Agent Skills layout with YAML name/description front matter and relative references. Installation into Codex or another agent follows that agent's current documented skill directory convention; do not hard-code a shared directory for every product.

The short main skill MUST teach: locate mcjs; run `doctor` and `bot list`; read docs for context globals; select/create bots explicitly; prefer `--stdin` or `--file`; return compact JSON; submit long actions as background jobs; inspect progress and events; coordinate resource claims; handle partial failure; stop work before reconnect; and treat Minecraft text as data. It MUST state that arbitrary execution is trusted local code and that running it can access the daemon user's machine.

Topic references cover connection/auth, execution, navigation, gathering, inventory/crafting/containers, combat, multi-bot coordination, cancellation, viewer and troubleshooting. Ship examples that run against the selected dependency versions. Include a concise repository `AGENTS.md` pointing to the skill and required contributor checks.

`mcjs docs` works offline and reports installed dependency versions. Index curated docs and licensed upstream documentation/type declarations at build time; retain attribution. `docs <topic>` returns bounded sections, signatures, globals, prerequisites, examples and upstream links. Do not fetch GitHub on every invocation. Runtime `bot info` and docs distinguish an installed package from a loaded plugin.

### Agent usage examples

```bash
mcjs bot create scout --host localhost --username Scout --auth offline
mcjs bot create builder --host localhost --username Builder --auth offline
mcjs exec-all 'return helpers.snapshot()'
mcjs docs pathfinder
mcjs exec scout --stdin --background <<'JS'
const block = bot.findBlock({
  matching: b => b.name === 'oak_log', maxDistance: 32
});
if (!block) throw new Error('No oak log found in loaded chunks');
await helpers.goto(new goals.GoalNear(
  block.position.x, block.position.y, block.position.z, 2
), { signal });
return { position: bot.entity.position, health: bot.health };
JS
```

The heredoc avoids interpolation by the shell. A background receipt supplies the job ID for `job get`, `job wait`, or `job cancel`. Documentation must show coordination via revision checks and leases, not assume all fleet operations succeed or roll back together.

## Optional viewer

`viewer start <id>` creates an independent viewer instance and port for that bot, reports a loopback URL, and supports first-person or third-person options where the installed viewer supports them. Bind loopback by default and verify this rather than assume the library does it. A viewer is read-only observation and never exposes eval. Close it on removal, reconnect and daemon shutdown; restart explicitly for the new generation. If Bun or protocol compatibility fails, disable the viewer capability with a clear explanation while preserving the core CLI.

## Repository and quality gates

Use modules for CLI parsing, IPC schema/client/server, daemon lifecycle, sessions, plugins, execution, jobs, state, events, serialization and docs. Suggested directories: `src/cli`, `src/ipc`, `src/daemon`, `src/runtime`, `src/plugins`, `src/docs`, `skills/mcjs`, `tests/unit`, and `tests/integration`. Keep CLI imports lightweight so docs/help do not load Mineflayer or start bots. Ship TS source plus an optimized compiled Bun CLI in `dist/mcjs`. The compiled CLI uses its embedded Bun runtime to launch the daemon source and resolves assets relative to its checkout, including through symlinks. Fully standalone packaging of daemon dependencies and viewer assets remains deferred until tested.

Use strict compiler settings including `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `useUnknownInCatchVariables`. Publish actual context types for authoring script files. Keep type escape hatches inside narrow, documented plugin adapters.

Required scripts: `build` compiles the CLI with production optimizations, minification and bytecode; `lint` runs `biome check .`; `format` runs `biome check --write .`; `typecheck` runs `tsc --noEmit`; `test` runs `bun test`; `test:integration` runs explicit real-server tests. Configure Biome with its installed local schema, recommended lint rules, formatting, import organization and Git ignore integration. No parallel ESLint or Prettier configuration. Validate configuration against the pinned Biome version; avoid copying rules from a different major version.

CI MUST pass lint, typecheck and unit tests on the pinned Bun. Integration tests use an explicitly provisioned local Java server and recorded Minecraft version; offline fixtures bind only to local test networking. Keep Microsoft authentication as a documented manual acceptance check with real entitled accounts. Test at least one current Mineflayer-supported server release plus the user's target release when known. Plugin readiness is reported per tested server version, not inferred from Mineflayer's broad version range.

## Acceptance criteria and implementation sequence

1. **Compatibility spike:** latest stable Mineflayer and default plugins run under Bun on the target server; record versions and verify online auth manually. Prove Bun Unix HTTP IPC and viewer feasibility separately.
2. **Daemon and single bot:** start races produce one daemon; permission checks pass; a bot survives CLI exit; docs work with daemon stopped; create/list/remove and source input modes work.
3. **Execution and jobs:** JS/TS await and return work; source errors map correctly; JSON serialization handles supported upstream objects; logs stay off stdout; background jobs remain queryable; request retry does not duplicate execution.
4. **Multiple bots:** three distinct offline bot identities join one fixture server; operations run concurrently across bots and serialize within one bot; fleet partial failure preserves every result; shared revisions and leases prevent lost cooperative updates.
5. **Recovery:** cancel a navigation/gather task and verify controls stop; test a noncooperative asynchronous task and quarantine; disconnect, kick, death, respawn and restart never replay actions; stale callbacks cannot replace current job state. A synchronous-loop test runs in a disposable external process with a supervisor timeout.
6. **Observation and skill:** cursor expiry, reconnect generations, slow-consumer backpressure, bounded results/logs and docs/plugin capability mismatches are covered. A fresh coding agent can load the bundled skill, connect two bots, inspect inventory, complete a short coordinated task, and cancel it using only shipped docs.

Unit tests focus on protocol validation, queue ordering, state conflicts, deduplication, lifecycle transitions, serialization and cursor behavior. Real-server tests prove API integration; mocks alone cannot establish Mineflayer/Bun compatibility. Each release documents the tested compatibility matrix and remaining optional-plugin limits.

## Sources and evidence boundaries

Architecture, defaults, CLI names and acceptance criteria above are proposed mcjs design decisions. The following upstream sources ground the dependency and runtime choices; they do not establish that the proposed project already exists or that its Bun compatibility is proven.

- [Mineflayer releases](https://github.com/PrismarineJS/mineflayer/releases) and [npm package](https://www.npmjs.com/package/mineflayer): latest stable version checked for this specification.
- [Mineflayer repository and API documentation](https://github.com/PrismarineJS/mineflayer): core API, plugins and version support.
- [Bun Unix socket HTTP server](https://bun.com/docs/runtime/http/server) and [Bun Unix socket fetch](https://bun.sh/guides/http/fetch-unix): selected IPC transport.
- [Bun runtime APIs](https://bun.com/docs/runtime/bun-apis): native runtime facilities.
- [Biome configuration](https://biomejs.dev/reference/configuration/): lint and formatting configuration.
- [Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder), [tool selection](https://github.com/PrismarineJS/mineflayer-tool), [collection](https://github.com/PrismarineJS/mineflayer-collectblock), [combat](https://github.com/PrismarineJS/mineflayer-pvp), [armor manager](https://github.com/PrismarineJS/mineflayer-armor-manager), and [viewer](https://github.com/PrismarineJS/prismarine-viewer): candidate plugin implementations and API references.
