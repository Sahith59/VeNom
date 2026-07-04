// Zero-dependency MCP server exposing agent-memory/ as tools the coding agent can call at inference.
// JSON-RPC 2.0 over stdio, newline-delimited (the MCP stdio transport). No SDK dependency — this keeps
// runtime deps at zero. stdout carries ONLY protocol messages; everything else goes to stderr.
import { searchMemory, readMemoryPath, appendEntry, renderStats, renderCompact, loadBudgets } from "./memory.js";

const PROTOCOL_VERSION = "2024-11-05";
// The version this hand-rolled server was actually built and tested against. Per the MCP spec, we echo
// the client's requested version only if we support it; otherwise we answer with our own version rather
// than claiming to speak one we don't.
const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION]);

export interface ServerCtx {
  memDir: string;
  coreDir: string;
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
];

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
