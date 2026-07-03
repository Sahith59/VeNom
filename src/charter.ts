// Fills CHARTER_TEMPLATE.md placeholders from the init answers. The two required, high-value
// fields (non-negotiables, scope) are asked; the rest get sensible defaults with a clear nudge to
// refine CHARTER.md — which every agent reads first.

export interface CharterAnswers {
  projectName: string;
  oneLiner: string;
  nonNegotiables: string;
  outOfLane?: string;
  ownerName?: string;
}

function formatList(input: string): string {
  const items = input
    .split(/\r?\n|;/)
    .map((s) => s.trim().replace(/^\d+[.)]\s*/, ""))
    .filter(Boolean);
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return items.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

export function fillCharter(template: string, a: CharterAnswers): string {
  const nn = formatList(a.nonNegotiables);
  const out = formatList(a.outOfLane ?? "");
  const values: Record<string, string> = {
    PROJECT_NAME: a.projectName || "This project",
    PROJECT_ONE_LINER: a.oneLiner || "_(edit CHARTER.md: one sentence on what this project is)_",
    PROJECT_NON_NEGOTIABLES:
      nn || "_(edit CHARTER.md: the rules that, if broken, mean the work failed even if it runs)_",
    PROJECT_IN_LANE: a.oneLiner
      ? `${a.oneLiner} — _(sharpen the boundary in CHARTER.md)_`
      : "_(edit CHARTER.md: what this project builds)_",
    PROJECT_ROADMAP: "_(edit CHARTER.md: what earns its place later, once the core is solid)_",
    PROJECT_OUT_OF_LANE: out || "_(edit CHARTER.md: what this project declines, by name)_",
    PROJECT_EXPANSION_RULE:
      "A new capability earns its place only if it strengthens the core in-lane job; anything that would turn this into a different product is declined and the reason logged.",
    OWNER_NAME: a.ownerName?.trim() || "the owner",
    OWNER_WRITING_STYLE: "plain English, conversational, no jargon",
  };
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  // Drop the template's "example shape" helper comment from the generated charter.
  result = result.replace(/\n<!-- Example shape[\s\S]*?-->\n/, "\n");
  return result;
}
