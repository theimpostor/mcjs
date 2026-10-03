# mcjs

Program Minecraft Java bots with JavaScript or TypeScript from a coding agent.
The CLI sends programs to a persistent Bun daemon; Mineflayer bots stay connected
between commands. Each bot has its own execution queue and memory.

Initial implementation, version 0.1.0. Built with Bun 1.4.2, Mineflayer 4.39.0,
TypeScript 7.0.2 and Biome 2.5.15. Dependencies are pinned in `bun.lock`.

## Quick start

Requires Bun 1.4.2+ on Linux or macOS and a reachable Minecraft Java server.
Windows users can run mcjs in WSL2. Install dependencies, build and link the command:

```sh
bun install --frozen-lockfile
bun run build
bun link
mcjs doctor
mcjs daemon start
```

If you prefer not to link, run `./dist/mcjs`. During development, use
`bun run mcjs --` to run the TypeScript source without rebuilding.

### Optimized CLI build

`bun run build` produces `dist/mcjs` for the current platform. It uses Bun's
production compilation, syntax and whitespace minification, tree shaking and
ahead-of-time bytecode for all function depths. Identifier renaming is disabled:
Bun 1.4.2's name-preservation option still renames dependency classes, breaking
Mineflayer's constructor-name checks and result serialization. Embedded source maps
preserve useful errors. Runtime discovery of `.env`, `bunfig.toml`,
`tsconfig.json` and `package.json` is disabled for the compiled CLI; export
configuration such as `MCJS_RUNTIME_DIR` and `XDG_STATE_HOME` in the environment.

The single binary includes the Bun runtime, CLI, daemon, Mineflayer dependencies,
Minecraft data, docs and agent skill. Copy it to another machine with a compatible
operating system and CPU architecture; no checkout, `node_modules`, or installed
Bun is needed to run it. Build separately on each target platform.

The CLI starts another instance of the same binary in daemon mode when needed.
That process keeps bots connected between CLI calls; help and docs do not load
Mineflayer. `skill path` extracts the bundled skill and references into a cache
inside the profile's state directory so other tools can read them. Runtime state,
logs and authentication caches remain separate from the executable.
Rebuild after source, dependency or bundled documentation changes, and restart
any running daemon to use the new build. See [Bun's executable build documentation](https://bun.com/docs/bundler/executables).

Offline authentication is the default. For a local offline-mode test server:

```sh
mcjs bot create scout --host localhost --username Scout
mcjs bot create builder --host localhost --username Builder
mcjs bot list
mcjs exec-all 'return helpers.snapshot()'
```

For an online-mode server use `--auth microsoft --username account@example.com`.
The CLI prints device-login instructions to stderr when authentication is needed.
Use separate entitled accounts for simultaneous online bots. Authentication caches
are private and separate per account.

Run a TypeScript program against a bot:

```sh
mcjs exec scout --lang ts --stdin <<'TS'
const items: Array<{ name: string; count: number }> =
  bot.inventory.items().map(i => ({ name: i.name, count: i.count }));
botState.lastInventory = items;
return { position: bot.entity.position, items };
TS
```

Run a longer action and inspect it without blocking your agent:

```sh
mcjs exec scout --background --timeout-ms 60000 --stdin <<'JS'
const p = bot.entity.position;
await helpers.goto(new goals.GoalNear(p.x + 5, p.y, p.z, 1));
return bot.entity.position;
JS
mcjs jobs list
mcjs job get <job-id>
mcjs job cancel <job-id>
mcjs events scout --follow
mcjs bot stop scout
mcjs daemon stop
```

The `exec` result is a job record containing `state`, `result`, `error` and `logs`.
An RPC envelope can have `ok: true` while the returned job has failed: `ok` means
the RPC request succeeded. The CLI uses a nonzero exit code for failed jobs it
waits for. `--background` and an elapsed `--wait-ms` return a pending job receipt.
Closing the CLI does not cancel a job or disconnect a bot.

## Load the agent skill

The bundled skill is [skills/mcjs/SKILL.md](skills/mcjs/SKILL.md).
It teaches connection, API discovery, code execution, jobs, cancellation and
multi-bot coordination. `mcjs skill path` locates it and `mcjs skill print` emits
its contents. Install it into an explicit skill root for your coding agent:

```sh
mcjs skill install --dir /absolute/path/to/your/agent/skills
```

This copies a `mcjs` subdirectory. Existing contents require `--force` to overwrite.
You can also tell an agent to read the repository's SKILL.md directly. Run
`mcjs docs` for the offline API guide and `mcjs --help` for commands.

## Implemented

- Bun HTTP over a private Unix socket, bearer authentication, start lock,
  daemon handshake, bounded requests and mutation request deduplication.
- Named Mineflayer sessions, connection status, explicit reconnect/remove/stop,
  offline and Microsoft auth wiring, snapshots and plugin introspection.
- JS/TS async function bodies with direct `bot`, `mcData`, `Vec3`, `goals`,
  `Movements`, `botState`, `shared`, `signal`, `helpers`, `log`, and `console`.
- Per-bot queues, parallel bots, fleet execution with partial results,
  background jobs, deadlines, cancellation and quarantine of noncooperative jobs.
- JSON result projection, bounded logs, paginated per-bot event history with cursors,
  bot memory and shared compare-and-set values and resource leases.
- Pathfinder, tool selection and collection enabled by default; opt-in PVP
  with `--plugins pathfinder,tool,collectblock,pvp`.
- Optimized compiled CLI, offline docs, packaged agent skill, Biome, type checking, unit/RPC tests,
  Unix-socket tests and Minecraft integration tests.

Navigation defaults disable incidental digging and block towers. Explicit
`bot.dig` and `helpers.collect` remain available. Programs may deliberately
change pathfinder movements if the task calls for it. The collection helper
preserves the navigation policy; direct collection plugin calls use upstream
movement settings.

## Execution limits

This is a trusted local code runner. Submitted code has the daemon user's host
permissions. Minecraft chat is untrusted data and never automatically runs code.
The CLI does not expose a TCP execution server. The test suite injects an
authenticated loopback transport to test the RPC handler in restricted hosts.

A deadline or canceled Promise does not forcibly terminate arbitrary code.
Cooperative programs use `helpers.sleep`, navigation helpers and
`helpers.checkpoint`. A job that does not settle within two seconds after abort
quarantines that bot. A synchronous infinite loop can freeze the entire daemon;
terminate the daemon externally in that case. A reconnect replaces the old bot,
but cannot undo actions already sent to the server or arbitrary host side effects.

Bot memory and job/event history are currently **in memory**. Daemon restart
loses them; auth caches persist. World searches only see loaded chunks. Fleet
execution is independent per bot and has no rollback.

## Checks

```sh
bun run check
bun run test:integration
```

Integration tests launch an isolated Flying Squid 1.12.0 server using Minecraft
protocol 1.21.4 on loopback, then connect real Mineflayer clients under Bun.
They exercise the compiled CLI, real bots, plugins, live inventory, chat, shared memory,
navigation, collection, cancellation, reconnect and disconnect. This is not a vanilla Java
server acceptance test.
To test your own disposable offline-mode Java server instead:

```sh
MCJS_TEST_HOST=127.0.0.1 MCJS_TEST_PORT=25565 \
MCJS_TEST_VERSION=1.21.4 bun run test:integration
```

The collection check needs accessible dirt or grass blocks near spawn.
These tests move bots, collect blocks and send chat; use a disposable world.
Microsoft device login remains a manual check requiring your accounts. CI runs
Linux and macOS.
If your execution host explicitly denies Unix-domain sockets, set
`MCJS_SKIP_UNIX=1` to skip socket-specific tests; RPC and bot integration
tests still run. CI does not set this flag.

## Next milestones

The full target design is [docs/spec.md](docs/spec.md). This first implementation
intentionally leaves the following work visible:

- Optional prismarine-viewer and armor-manager adapters and compatibility tests.
- Disk checkpoints, saved bot definitions and bounded retention across repeated
  removals/reconnects (active-session completed job retention is bounded today).
- Push streaming for events; `events --follow` currently drains available pages
  as NDJSON envelopes, then polls every 500 ms.
- Full upstream API/types indexing; shipped docs currently cover core operations.
- Source maps back to original TS lines; errors identify the job source, but line
  numbers currently refer to the transpiled wrapper.
- Automated recovery of verified stale sockets/locks; current behavior refuses
  unresponsive existing endpoints and gives a diagnostic path.
- Native Windows transport, per-bot process isolation and optional viewer distribution.
- Vanilla Java/current-protocol acceptance matrix and manual Microsoft auth checks.
