// Tool detection + adapter loading. Adapters are plain ESM in adapters/<id>/adapter.mjs, so they
// are imported at runtime (no build step) — which is what lets the community add an adapter as one file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface InstallResult {
  roles: string[];
  agentsWritten: number;
  actions: Record<string, string>;
  warnings: string[];
  layout?: Array<{ label: string; path: string; note?: string }>;
}

export interface AdapterModule {
  meta: {
    id: string;
    name: string;
    agentsDir: string;
    settingsPath: string;
    startHint?: string;
    detect(dir: string): boolean;
  };
  install(opts: Record<string, unknown>): InstallResult;
}

export interface AdapterInfo {
  id: string;
  name: string;
  status: "ready" | "coming-soon";
}

export const ADAPTERS: AdapterInfo[] = [
  { id: "claude-code", name: "Claude Code", status: "ready" },
  { id: "codex", name: "Codex", status: "ready" },
  { id: "gemini", name: "Gemini CLI", status: "ready" },
];

export function detectTool(dir: string): string {
  // A prior Venom install is the strongest signal — re-init the same tool it was set up for.
  try {
    const rec = join(dir, ".venom", "install.json");
    if (existsSync(rec)) {
      const tool = (JSON.parse(readFileSync(rec, "utf8")) as { tool?: string }).tool;
      if (typeof tool === "string" && ADAPTERS.some((a) => a.id === tool)) return tool;
    }
  } catch {
    // fall through to filesystem heuristics
  }
  if (existsSync(join(dir, ".claude")) || existsSync(join(dir, "CLAUDE.md"))) return "claude-code";
  if (existsSync(join(dir, ".gemini")) || existsSync(join(dir, "GEMINI.md"))) return "gemini";
  if (existsSync(join(dir, ".codex"))) return "codex";
  // AGENTS.md is a cross-tool convention, not a Codex-only marker, so it is deliberately NOT a
  // detection signal. Claude Code is the most common tool for this audience, so it's the safe default.
  return "claude-code";
}

export async function loadAdapter(pkgRoot: string, id: string): Promise<AdapterModule> {
  const p = join(pkgRoot, "adapters", id, "adapter.mjs");
  if (!existsSync(p)) throw new Error(`adapter "${id}" is not available`);
  return (await import(pathToFileURL(p).href)) as unknown as AdapterModule;
}
