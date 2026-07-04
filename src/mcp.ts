// Zero-dependency MCP server exposing agent-memory/ as tools the coding agent can call at inference.
// JSON-RPC 2.0 over stdio, newline-delimited (the MCP stdio transport). No SDK dependency — this keeps
// runtime deps at zero. stdout carries ONLY protocol messages; everything else goes to stderr.
import { searchMemory, readMemoryPath, appendEntry, renderStats, renderCompact, loadBudgets } from "./memory.js";
import { loadRoster, agentBrief, routeTask, logTeamForRole } from "./router.js";

const PROTOCOL_VERSION = "2024-11-05";
// The version this hand-rolled server was actually built and tested against. Per the MCP spec, we echo
// the client's requested version only if we support it; otherwise we answer with our own version rather
// than claiming to speak one we don't.
const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION]);

export interface ServerCtx {
  memDir: string;
  coreDir: string;
  projectDir: string;
  version: string;
  now: () => Date;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  run: (args: Record<string, unknown>, ctx: ServerCtx) => string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean => v === true;

function stripAnsi(s: string): string {
  // renderStats/renderCompact emit no ANSI when stdout isn't a TTY (server mode), but strip defensively.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // don't cut a surrogate pair in half
  return s.slice(0, end);
}

export const TOOLS: Tool[] = [
  {
    name: "memory_search",
    description:
      "Search the team's shared memory (SNAPSHOT, team logs, lessons, distilled notes, ADRs, decisions) and return the most relevant entries with their refs. Use it to pull only the slice you need instead of reading whole files. Keyword ranking with field weighting.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for (keywords)." },
        limit: { type: "number", description: "Max results (default 8, capped at 50)." },
        includeArchived: { type: "boolean", description: "Also search compacted cold archives (default false)." },
      },
      required: ["query"],
    },
    run: (a, ctx) => {
      const query = str(a.query);
      if (!query) throw new Error("query is required");
      const hits = searchMemory(ctx.memDir, query, { limit: num(a.limit), includeArchived: bool(a.includeArchived) });
      if (hits.length === 0) return `No memory matched "${query}". Try broader keywords, or includeArchived: true.`;
      return hits.map((h, i) => `${i + 1}. [${h.field}] ${h.ref}\n   ${h.snippet}`).join("\n");
    },
  },
  {
    name: "memory_read",
    description:
      'Read a specific memory file (e.g. "SNAPSHOT.md", "dev/log.md") or a single log entry (path plus a 1-based entry number). Paths are relative to agent-memory/.',
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to agent-memory/, e.g. dev/log.md or SNAPSHOT.md." },
        entry: { type: "number", description: "Optional 1-based entry number to read just that one log entry." },
      },
      required: ["path"],
    },
    run: (a, ctx) => {
      const path = str(a.path);
      if (!path) throw new Error("path is required");
      const r = readMemoryPath(ctx.memDir, path, num(a.entry));
      const MAX = 20000;
      const text = r.text.length > MAX ? clip(r.text, MAX) + `\n…[truncated — narrow with memory_search or an entry number]` : r.text;
      return `# ${r.ref}\n${text}`;
    },
  },
  {
    name: "memory_append",
    description:
      "Append a correctly-formatted entry to a team log (the write-after-turn step). team is one of dev, research, review, security. The entry is timestamped and blank-line-separated so it stays compaction-safe.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "dev | research | review | security" },
        agent: { type: "string", description: "Your role name, e.g. developer-1." },
        title: { type: "string", description: "Short title of the action." },
        task: { type: "string", description: "What you were asked to do." },
        did: { type: "string", description: "What you actually did." },
        result: { type: "string", description: "The outcome / verdict / finding." },
        refs: { type: "string", description: "Files touched; the ADR/lesson you built on." },
        next: { type: "string", description: "What this unblocks / who needs to know." },
      },
      required: ["team", "agent", "title"],
    },
    run: (a, ctx) => {
      const r = appendEntry(
        ctx.memDir,
        {
          team: str(a.team) ?? "",
          agent: str(a.agent) ?? "",
          title: str(a.title) ?? "",
          task: str(a.task),
          did: str(a.did),
          result: str(a.result),
          refs: str(a.refs),
          next: str(a.next),
        },
        ctx.now(),
      );
      return `Appended ${r.ref}\n${r.header}`;
    },
  },
  {
    name: "memory_stats",
    description: "Report the shared-memory footprint: hot read-path vs. cold archives, per-file tokens, and which logs are over budget.",
    inputSchema: { type: "object", properties: {} },
    run: (_a, ctx) => stripAnsi(renderStats(ctx.memDir, loadBudgets(ctx.coreDir))),
  },
  {
    name: "memory_compact",
    description:
      "Bound the team logs by archiving old entries — keeps the newest N per log and moves the rest to log.archive.md, verbatim (never deletes). Dry-run by default; pass write:true to apply.",
    inputSchema: {
      type: "object",
      properties: {
        keep: { type: "number", description: "Newest entries to keep hot per log (default 20)." },
        write: { type: "boolean", description: "Apply the change (default false = dry run)." },
      },
    },
    run: (a, ctx) => stripAnsi(renderCompact(ctx.memDir, { keep: num(a.keep) }, bool(a.write), loadBudgets(ctx.coreDir))),
  },
  {
    name: "list_agents",
    description:
      "List the agents actually installed in THIS project (from the Venom install record), each with its one-line purpose. Use it to see who you can delegate to. Reflects a custom roster (venom init --roles), not a fixed list. You talk to boss-1; it delegates to the rest.",
    inputSchema: { type: "object", properties: {} },
    run: (_a, ctx) => formatRoster(ctx),
  },
  {
    name: "agent_brief",
    description:
      "Return one agent's full spec — its persona, mandate, how it works, and the gates it answers to — so you can act as it or brief a subagent with it. Arg: role (e.g. developer-1). Call list_agents for the names.",
    inputSchema: {
      type: "object",
      properties: { role: { type: "string", description: "Role name, e.g. developer-1 or security." } },
      required: ["role"],
    },
    run: (a, ctx) => {
      const role = str(a.role);
      if (!role) throw new Error("role is required");
      return formatBrief(agentBrief(ctx.coreDir, ctx.projectDir, role));
    },
  },
  {
    name: "route",
    description:
      "Given a plain-English task, suggest which of your INSTALLED agents fit and the order to run them. This is an honest keyword/field match over each agent's spec — a shortcut to the likely specialists, NOT a judgment call. boss-1 is your real router; this just narrows the field. Arg: task. Optional: limit (top-N, default 3).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What you want done, in plain English." },
        limit: { type: "number", description: "How many candidate agents to return (default 3, max 6)." },
      },
      required: ["task"],
    },
    run: (a, ctx) => {
      const task = str(a.task);
      if (!task) throw new Error("task is required");
      return formatRoute(routeTask(ctx.coreDir, ctx.projectDir, task, { limit: num(a.limit) }));
    },
  },
  {
    name: "handoff",
    description:
      "Delegate a task to an installed agent: returns that agent's full brief AND records the delegation in shared memory (agent-memory/) so parallel/async work stays traceable. The MCP can't run the agent — you (the host) act on the brief; this makes the dispatch visible. Args: role, task. Optional: by (delegator, default boss-1).",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "The agent to delegate to, e.g. developer-1." },
        task: { type: "string", description: "The bounded task you're handing off." },
        by: { type: "string", description: "Who is delegating (default boss-1)." },
      },
      required: ["role", "task"],
    },
    run: (a, ctx) => {
      const role = str(a.role);
      const task = str(a.task);
      if (!role) throw new Error("role is required");
      if (!task) throw new Error("task is required");
      const roster = loadRoster(ctx.coreDir, ctx.projectDir);
      if (!roster.roles.some((r) => r.role === role)) {
        throw new Error(`"${role}" is not installed here. Call list_agents to see the roster, or add it with \`venom add ${role}\`.`);
      }
      const by = str(a.by) || "boss-1";
      const team = logTeamForRole(ctx.coreDir, role);
      const rec = appendEntry(
        ctx.memDir,
        {
          team,
          agent: by,
          title: `Handoff → ${role}`,
          task,
          did: `Delegated to ${role} via MCP handoff.`,
          next: `${role}: act on the brief below, then log your result. critics + security gate before it's done.`,
        },
        ctx.now(),
      );
      return `Handoff logged — ${rec.ref}\n${rec.header}\n\n${formatBrief(agentBrief(ctx.coreDir, ctx.projectDir, role))}`;
    },
  },
];

function formatRoster(ctx: ServerCtx): string {
  const roster = loadRoster(ctx.coreDir, ctx.projectDir);
  const toolName = { "claude-code": "Claude Code", codex: "Codex", gemini: "Gemini CLI" }[roster.tool] ?? roster.tool;
  const head = `Installed agents (${roster.roles.length})${roster.pack ? ` — ${roster.pack} pack` : ""}${toolName ? `, ${toolName}` : ""}`;
  const pad = Math.max(...roster.roles.map((r) => r.role.length), 8);
  const lines = roster.roles.map((r) => `  ${r.role.padEnd(pad)}  ${r.title}${r.summary ? " — " + r.summary : ""}`);
  return [
    head,
    "You talk to boss-1; it delegates to the rest.",
    "",
    ...lines,
    "",
    "Next: agent_brief(role) for a full spec · route(task) to find the fit · handoff(role, task) to delegate + log it.",
  ].join("\n");
}

function formatBrief(b: ReturnType<typeof agentBrief>): string {
  const header = [
    `# ${b.role} — ${b.title}`,
    b.summary ? `_${b.summary}_` : "",
    `team: ${b.team} · reports to: ${b.reportsTo}${b.installed ? "" : " · ⚠ not currently installed here (venom add " + b.role + ")"}`,
    "",
  ].filter((l) => l !== "");
  return header.join("\n") + "\n\n" + b.body;
}

function formatRoute(r: ReturnType<typeof routeTask>): string {
  const L: string[] = [];
  L.push(`Routing "${r.task}" over ${r.installedCount} installed agents.`);
  L.push("Keyword match on each agent's spec — a shortcut, not a judgment. boss-1 is the real router.");
  L.push("");
  if (r.candidates.length === 0) {
    L.push(r.terms.length === 0
      ? "No specific keywords to match on. Hand it to boss-1 — it scopes and routes anything."
      : "No agent's spec matched those keywords. Hand it to boss-1 — it scopes and routes anything.");
  } else {
    // "Closest matches", not "best-fit" — a single generic-word hit (e.g. "data") can surface a role
    // that only coincidentally overlaps. The matched-keywords annotation below is the honest signal.
    L.push("Closest matches (by keyword overlap — check the matched terms):");
    r.candidates.forEach((c, i) => {
      L.push(`  ${i + 1}. ${c.role} — ${c.title}${c.matched.length ? `   (matched: ${c.matched.join(", ")})` : ""}`);
      if (c.summary) L.push(`     ${c.summary}`);
      if (c.brief) L.push(`     ${c.brief}`);
    });
  }
  if (r.missingTip) {
    L.push("");
    L.push(`Tip: your roster has no ${r.missingTip.role} (${r.missingTip.title}), which looks like the closest fit. Add it with \`venom add ${r.missingTip.role}\` if you need it.`);
  }
  if (r.flow.length) {
    L.push("");
    L.push("Suggested pass (Venom's standard flow, narrowed to your matched roles):");
    r.flow.forEach((f, i) => L.push(`  ${i + 1}. ${f.role} — ${f.note}`));
  }
  L.push("");
  L.push("Get a full spec with agent_brief(role), or delegate + log it with handoff(role, task).");
  return L.join("\n");
}

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

interface JsonRpc {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

// Pure dispatch: returns the response object to send, or null for a notification (no reply).
export function handleMessage(msg: JsonRpc, ctx: ServerCtx): object | null {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const { id, method, params } = msg;
  // A notification (no id) gets NO reply and NO side effects — this must run before the method
  // dispatch, or a request-shaped notification (e.g. a stray tools/call with no id) would execute
  // and emit a malformed id-less frame onto the protocol channel.
  if (id === undefined || id === null) return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(str(params?.protocolVersion) ?? "") ? str(params?.protocolVersion) : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "venom-memory", version: ctx.version },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
  }
  if (method === "tools/call") {
    const name = str(params?.name);
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    const tool = name ? toolByName.get(name) : undefined;
    if (!tool) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Unknown tool: ${name ?? "(none)"}` }], isError: true } };
    try {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: tool.run(args, ctx) }] } };
    } catch (err) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true } };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method ?? "(none)"}` } };
}

function processLine(line: string, ctx: ServerCtx): void {
  const t = line.trim();
  if (!t) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return; // non-JSON line: can't attribute an id, so drop it
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    // An empty batch is itself an Invalid Request per JSON-RPC 2.0 — reply with a single -32600.
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }) + "\n");
    return;
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed]; // support JSON-RPC batches
  const out: object[] = [];
  for (const m of msgs) {
    let res: object | null = null;
    try {
      res = handleMessage(m as JsonRpc, ctx);
    } catch (err) {
      process.stderr.write(`venom-memory: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    if (res) out.push(res);
  }
  if (out.length === 0) return; // all notifications, or an empty batch — nothing to send
  process.stdout.write(JSON.stringify(Array.isArray(parsed) ? out : out[0]) + "\n");
}

export function runMemoryServer(ctx: ServerCtx): void {
  const MAX_LINE = 8 * 1024 * 1024; // drop any single message larger than 8 MB (line-buffer DoS guard)
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE && buf.indexOf("\n") === -1) {
      process.stderr.write(`venom-memory: dropping oversized message (> ${MAX_LINE} bytes, no newline)\n`);
      buf = "";
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      processLine(line, ctx);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`venom-memory MCP server ready — memory at ${ctx.memDir}\n`);
}
