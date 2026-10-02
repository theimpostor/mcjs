# mcjs

Use Bun and strict TypeScript. Use Biome for linting and formatting. Run
`bun run check` before committing. Run `bun run test:integration` when changing
IPC, Mineflayer integration, or execution against a real bot. See README for
the current implementation scope and integration environment variables.

Preserve JSON-only CLI stdout. Keep Mineflayer imports out of help/docs paths.
Never assume Promise cancellation terminates arbitrary JavaScript. Keep
timeouts, cancellation, queue ordering and retry semantics covered by tests.
Do not commit auth caches, tokens, runtime sockets, logs or server world data.

The loadable Minecraft operation skill is `skills/mcjs/SKILL.md`.
The target design is `docs/spec.md`; document deliberate implementation gaps
in README instead of presenting unimplemented commands as working.
