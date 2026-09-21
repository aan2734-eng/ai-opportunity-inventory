/**
 * ESM resolve/load hooks so `node --test` can import the app's modules the way
 * the Next.js bundler does. Node 22 strips TypeScript types on its own, but it
 * does not know about three things this project relies on:
 *
 *   1. the `@/*` path alias from tsconfig.json
 *   2. extensionless relative specifiers (`./appsScript`)
 *   3. JSON imported without an `with { type: "json" }` attribute
 *
 * Registered by tests/register.mjs; see the `test` script in package.json.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const PROJECT_ROOT = new URL("../", import.meta.url);
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"];

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

function firstExisting(base) {
  for (const suffix of EXTENSIONS.flatMap((ext) => [ext, `/index${ext}`])) {
    const candidate = new URL(base.href + suffix);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const isPath = specifier.startsWith("@/") || specifier.startsWith(".") || specifier.startsWith("/");
  if (!isPath) return nextResolve(specifier, context);

  // Keep any `?cacheBust=…` query so tests can re-import a module with fresh
  // module-level state (lib/appsScript.ts reads env vars at import time).
  const queryAt = specifier.indexOf("?");
  const query = queryAt === -1 ? "" : specifier.slice(queryAt);
  const bare = queryAt === -1 ? specifier : specifier.slice(0, queryAt);

  const base = specifier.startsWith("@/")
    ? new URL(bare.slice(2), PROJECT_ROOT)
    : new URL(bare, context.parentURL ?? PROJECT_ROOT);

  const resolved = isFile(base) ? base : firstExisting(base);
  if (!resolved) return nextResolve(specifier, context);
  return nextResolve(resolved.href + query, context);
}

export async function load(url, context, nextLoad) {
  const { pathname } = new URL(url);

  // JSON is imported without an import attribute (`@/data/…json`), which plain
  // Node ESM rejects. Hand it back as a module with a default export instead.
  if (pathname.endsWith(".json")) {
    const source = await readFile(new URL(url), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${source};` };
  }

  // Tell Node these are ES modules up front: without "type": "module" in
  // package.json it would otherwise try CommonJS first and warn on every run.
  if (/\.(ts|tsx|mts)$/.test(pathname)) {
    return nextLoad(url, { ...context, format: "module-typescript" });
  }

  return nextLoad(url, context);
}
