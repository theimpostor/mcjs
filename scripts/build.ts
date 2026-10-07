import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
mkdirSync("dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  root: ".",
  target: "bun",
  format: "esm",
  // The optional viewer serves its installed browser assets from disk.
  external: ["prismarine-viewer"],
  // Bun 1.4.2 still renames imported classes with keepNames enabled.
  // Mineflayer and our serializers dispatch on their constructor names.
  minify: {
    whitespace: true,
    syntax: true,
    identifiers: false,
    keepNames: true,
  },
  bytecode: true,
  treeShaking: true,
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  compile: {
    outfile: "./dist/mcjs",
    assets: ["docs", "skills", "package.json"],
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    // Runtime package main/exports resolution is needed for optional viewers.
    autoloadPackageJson: true,
  },
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exitCode = 1;
} else {
  console.log(
    "Built dist/mcjs with its daemon, dependencies, docs, and skill.",
  );
}
