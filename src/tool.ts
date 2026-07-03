// Tool detection + adapter loading. Adapters are plain ESM in adapters/<id>/adapter.mjs, so they
// are imported at runtime (no build step) — which is what lets the community add an adapter as one file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface InstallResult {
  roles: string[];
  agentsWritten: number;
  actions: Record<string, string>;
  warnings: string[];
}

export interface AdapterModule {
  meta: { id: string; name: string; agentsDir: string; settingsPath: string; detect(dir: string): boolean };
  install(opts: Record<string, unknown>): InstallResult;
}

export interface AdapterInfo {
  id: string;
  name: string;
  status: "ready" | "coming-soon";
}

export const ADAPTERS: AdapterInfo[] = [
  { id: "claude-code", name: "Claude Code", status: "ready" },
  { id: "codex", name: "Codex", status: "coming-soon" },
  { id: "gemini", name: "Gemini CLI", status: "coming-soon" },
];

export function detectTool(dir: string): string {
  if (existsSync(join(dir, ".claude")) || existsSync(join(dir, "CLAUDE.md"))) return "claude-code";
  // Claude Code is the one ready adapter in v1, so it's the safe default.
  return "claude-code";
}

export async function loadAdapter(pkgRoot: string, id: string): Promise<AdapterModule> {
  const p = join(pkgRoot, "adapters", id, "adapter.mjs");
  if (!existsSync(p)) throw new Error(`adapter "${id}" is not available`);
  return (await import(pathToFileURL(p).href)) as unknown as AdapterModule;
}
