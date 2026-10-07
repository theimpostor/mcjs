# Browser viewer

The optional prismarine-viewer 1.33.0 adapter shows a connected bot's surroundings
in a browser with WebGL support. Start with a ready bot and the same profile used
to create it:

```sh
mcjs bot info scout
mcjs viewer start scout
mcjs bot info scout
mcjs viewer stop scout
```

Open the start result's `url` on the daemon's machine. The HTTP server listens
only on IPv4 loopback (`127.0.0.1`). Each bot has its own server and port. Bot info
contains `viewer: null` when inactive, or an object with `url`, `port`,
`firstPerson`, `viewDistance` and the bot's `generation` when active. The CLI
continues to return JSON and does not open a browser automatically.

## Options and camera

```sh
mcjs viewer start scout --port 3000 --first-person --view-distance 6
```

- `--port`: 0 to choose a free port, or 1 through 65535 for a specific port.
  The default is 0. Viewer ports are separate from the Minecraft server port.
- `--first-person`: follow the bot's eyes, yaw and pitch. Omit it for third-person
  view, where you can orbit, pan and zoom independently.
- `--view-distance`: radius in chunks, 1 through 16, default 6. Increasing it
  displays more of the bot's loaded world and uses more browser resources; it
  does not load new server chunks or move the bot.

In third-person view, left-drag to orbit, right-drag to pan, and scroll to zoom.
The browser is for observation: its input does not move the bot, dig blocks, send
chat or execute code. Use mcjs execution commands for bot actions.

Repeating start with matching settings returns the existing viewer. An omitted
port or `--port 0` also matches its already assigned port. Different settings
return `VIEWER_ALREADY_RUNNING`; stop the viewer and start it with the new
options. Closing a browser tab does not stop the viewer or the Minecraft
connection. `viewer stop` closes the HTTP server and its browser connections
without stopping bot jobs.

The viewer belongs to one bot connection generation. Bot removal, reconnect,
disconnect, death, respawn, dimension changes, quarantine and daemon shutdown
close it. Once the bot is ready again, it requires an explicit
`viewer start`; old URLs may no longer be valid. Check bot info for the current
URL instead of assuming a previous automatically chosen port will be reused.

## Optional installation

A checkout's regular `bun install --frozen-lockfile` installs the pinned optional
package with its browser assets. A core-only installation can use
`bun install --frozen-lockfile --omit optional`. Help, docs and bot execution do
not require the viewer package.

The compiled mcjs executable keeps the viewer outside the binary. When using it
without the checkout, install the viewer in a dedicated directory:

```sh
mkdir -p "$HOME/.local/share/mcjs-viewer"
cd "$HOME/.local/share/mcjs-viewer"
bun add --exact prismarine-viewer@1.33.0
export MCJS_VIEWER_DIR="$HOME/.local/share/mcjs-viewer"
mcjs daemon start
```

Set `MCJS_VIEWER_DIR` to the installation root containing `node_modules`. Export
it before starting the daemon. Restart an existing daemon deliberately to pick up
environment changes; this disconnects its bots. Dependencies and public assets
must remain on disk while the viewer runs. No automatic package installation or
download happens when starting a viewer.

## Compatibility and troubleshooting

Minecraft 1.21.4 is in the pinned viewer's rendering version list. mcjs requires
an exact match in that list and the matching browser assets. It does not use
upstream's fallback to another version's textures and models. Connection support
in Mineflayer does not establish rendering support in prismarine-viewer. This is
a view of loaded chunks and entities, not a full Minecraft client or complete
world map. Upstream visual differences can remain even on a supported version.

`VIEWER_UNAVAILABLE` means dependencies or browser assets are unavailable; restore
the pinned optional package or set `MCJS_VIEWER_DIR` before starting the daemon.
`VIEWER_UNSUPPORTED_VERSION` reports the installed viewer's accepted Minecraft
versions. `VIEWER_START_FAILED` includes the underlying listener error; if a
requested port is occupied, use another port or omit `--port`.
`VIEWER_INTERRUPTED` means a stop or bot lifecycle change interrupted startup;
check bot info and start again once the intended connection is ready.

If a tab stops updating, check `mcjs bot info <id>` and the current viewer URL.
After a connection change, explicitly start a fresh viewer. For a blank browser
view, allow the initial chunk render to finish, confirm WebGL works, and try a
lower `--view-distance`. Starting the viewer does not change Minecraft server
authentication or networking settings.

Upstream implementation and API documentation:
https://github.com/PrismarineJS/prismarine-viewer
