# Troubleshooting

Start with mcjs doctor, daemon status and bot info <id>. Inspect job state/error,
then mcjs events <id>. Do not blindly resubmit mutations after a lost response.

DAEMON_UNAVAILABLE: start the daemon, check profile/socket path, and inspect the
private daemon log indicated on start failure. STALE_SOCKET/START_LOCKED: inspect
the recorded PID and local processes; remove only an endpoint or lock whose owner
you have verified is no longer running. Never remove an active daemon's socket.

BOT_NOT_READY: wait for spawn/login or inspect connection events. On auth_required,
complete device login. ACCOUNT_IN_USE: use another entitled Microsoft account.
BOT_BUSY: await/cancel the current job. Quarantined: noncooperative code failed to
settle; reconnect deliberately after checking for already-completed actions.

Unknown API: mcjs docs, then inspect the namespace or read the installed upstream
types. PLUGIN_MISSING: create/reconnect with the required configured plugin.
RESULT_TOO_LARGE/SERIALIZATION_ERROR: return a compact JSON projection. World
mutations may already have occurred before result serialization failed.

Snapshots and searches only reflect loaded chunks. No result from findBlock does
not prove the resource is absent from the world. A pathfinder failure may mean
terrain, movement restrictions, tools or unloaded chunks block the route.
