# Observe a bot in the browser

Reuse the task's bot and profile. Read `mcjs bot info <id>` to confirm readiness
and check whether `viewer` already contains a URL. Otherwise start one:

```sh
mcjs viewer start scout
mcjs bot info scout
```

Open the returned URL on the daemon's machine. The viewer binds to `127.0.0.1`,
selects a free port by default, and displays the bot's loaded surroundings.
Browser camera controls do not control the bot. Use exec for bot actions.

For a first-person view, stop the existing viewer and restart it:

```sh
mcjs viewer stop scout
mcjs viewer start scout --first-person --view-distance 6
```

Use `--port <number>` if the user needs a specific port. View distance accepts
1 through 16 chunks and defaults to 6. Third-person view is the default; drag
to orbit, right-drag to pan and scroll to zoom.

Stopping the viewer leaves the bot and its jobs running. Closing a browser tab
leaves the viewer running. Bot removal, reconnect, disconnect and daemon shutdown
close it; explicitly restart it for a new connection and use its new URL.

If viewer startup reports unavailable dependencies, read `mcjs docs viewer
--human` for installation. The optional pinned prismarine-viewer package and its
browser assets must be available to the daemon; they are external to the compiled
mcjs binary. Do not install arbitrary packages in submitted bot code or modify
Minecraft server settings to repair a viewer.
