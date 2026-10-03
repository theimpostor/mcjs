export {};

const args = process.argv.slice(2);

if (args[0] === "__mcjs_daemon") {
  const { runDaemon } = await import("./daemon/main.ts");
  await runDaemon(args[1], args[2]);
} else {
  const { runCli } = await import("./cli.ts");
  await runCli(args);
}
