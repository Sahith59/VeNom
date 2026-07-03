// Model presets — resolve a preset into a per-role model plan the adapters + estimator consume.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface ModelPlan {
  preset: string;
  perRole: boolean; // true when the tool applies a model per role (Claude Code)
  modelByRole: Record<string, string>;
  tierByRole: Record<string, string>;
  sessionModel: string; // recommended single model for one-session tools (Codex/Gemini)
}

export function loadModels(coreDir: string): Json {
  return JSON.parse(readFileSync(join(coreDir, "models.json"), "utf8"));
}

export function presetNames(coreDir: string): string[] {
  return Object.keys(loadModels(coreDir).presets);
}

function groupOf(models: Json, role: string): string {
  for (const [g, list] of Object.entries(models.groups)) {
    if ((list as string[]).includes(role)) return g;
  }
  return "workers";
}

/** Resolve a preset for a tool over the given roles into a concrete model plan. Throws on unknown preset. */
export function resolvePreset(coreDir: string, roles: string[], toolId: string, preset: string): ModelPlan {
  const models = loadModels(coreDir);
  const p = models.presets[preset];
  if (!p) throw new Error(`unknown model preset "${preset}". Available: ${Object.keys(models.presets).join(", ")}`);

  const tierModels = models.tierModels[toolId] || models.tierModels["claude-code"];
  const modelByRole: Record<string, string> = {};
  const tierByRole: Record<string, string> = {};
  for (const r of roles) {
    const tier = p[groupOf(models, r)] || p.workers;
    tierByRole[r] = tier;
    modelByRole[r] = tierModels[tier];
  }
  return {
    preset,
    perRole: toolId === "claude-code",
    modelByRole,
    tierByRole,
    sessionModel: tierModels[p.workers], // one-session tools: recommend the workers-tier model
  };
}
