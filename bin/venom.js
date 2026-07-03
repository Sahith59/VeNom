#!/usr/bin/env node
// Venom CLI entrypoint. Thin launcher: it defers all logic to the compiled CLI in dist/
// so this file stays stable across versions. Built from src/ (see package.json "build").
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/cli.js");

if (!existsSync(entry)) {
  console.error(
    "venom: build output not found (dist/cli.js).\n" +
      "If you are developing venomkit locally, run `npm run build` first."
  );
  process.exit(1);
}

await import(entry);
