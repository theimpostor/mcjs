const squid = require("flying-squid");
const settings = require("flying-squid/config/default-settings.json");
const server = squid.createMCServer({
  ...settings,
  host: "127.0.0.1",
  port: 0,
  "online-mode": false,
  logging: false,
  "view-distance": 2,
  "everybody-op": true,
  worldFolder: undefined,
  generation: { name: "grass_field", options: {} },
  version: "1.21.4",
});
server.on("ready", () =>
  console.log(JSON.stringify({ port: server.listeningPort })),
);
server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
