import { McjsError } from "../errors.ts";

export async function executeCode(
  code: string,
  lang: "js" | "ts",
  context: Record<string, unknown>,
  sourceId: string,
) {
  const names = Object.keys(context);
  const wrapper = `export default async function mcjs_program(${names.join(",")}) {\n"use strict";\n${code}\n}`;
  const compiled = new Bun.Transpiler({ loader: lang }).transformSync(wrapper);
  // Exporting keeps the transpiler from eliminating the unused function.
  // Function creates a global-scope closure: this module's locals stay private.
  // This executes trusted local programs, and is deliberately not a sandbox.
  const callable: unknown = new Function(
    `${compiled.replace(/^export default /m, "return ")}\n//# sourceURL=mcjs-job-${sourceId}.${lang}`,
  )();
  if (typeof callable !== "function")
    throw new McjsError(
      "COMPILE_ERROR",
      "Source did not compile to a function",
    );
  return await callable(...Object.values(context));
}

export function abortableSleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
