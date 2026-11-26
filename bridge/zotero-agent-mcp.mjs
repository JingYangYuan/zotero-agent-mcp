#!/usr/bin/env node
/* zotero-agent MCP bridge — zero-dependency Model Context Protocol server over stdio.
 * Released by "Zotero-Agent-MCP" to <Zotero data dir>/zotero-agent-mcp/zotero-agent-mcp.mjs.
 *
 * Config (CLI args or env):
 *   --token / -t       or ZOTERO_AGENT_TOKEN (bearer token from Zotero Settings → AgentMCP;
 *                      falls back to ~/Zotero/zotero-agent-mcp/token when readable)
 *   --url / -u         or ZOTERO_AGENT_URL (default http://127.0.0.1:23119/zotero-agent-mcp)
 *   --tools            or ZOTERO_AGENT_TOOLS: "full" (default, 34 tools) or "core" (13 tools)
 *
 * Protocol: newline-delimited JSON-RPC 2.0 (MCP stdio transport).
 * All diagnostics go to stderr; stdout carries only protocol messages.
 *
 * v0.6.0: one-line tool descriptions + MCP annotations (smaller tools/list, ~55% of v0.5.1),
 * compact JSON responses, tools/list result serialized once at startup.
 */

import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.6.2";

function parseArgs(argv) {
  const opts = { token: "", url: "", tools: "", help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--version" || a === "-v") {
      opts.version = true;
    } else if (a === "--token" || a === "-t") {
      if (i + 1 < argv.length) opts.token = argv[++i];
    } else if (a.startsWith("--token=")) {
      opts.token = a.slice("--token=".length);
    } else if (a === "--url" || a === "-u") {
      if (i + 1 < argv.length) opts.url = argv[++i];
    } else if (a.startsWith("--url=")) {
      opts.url = a.slice("--url=".length);
    } else if (a === "--tools") {
      if (i + 1 < argv.length) opts.tools = argv[++i];
    } else if (a.startsWith("--tools=")) {
      opts.tools = a.slice("--tools=".length);
    }
  }
  return opts;
}

function readFallbackToken() {
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "token"),
    path.join(os.homedir(), "Zotero", "zotero-agent-mcp", "token"),
    path.join(os.homedir(), "Documents", "Zotero", "zotero-agent-mcp", "token"),
  ];
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, "utf8").trim();
      if (t) return t;
    } catch {}
  }
  return "";
}

const CLI = parseArgs(process.argv.slice(2));
if (CLI.version) {
  process.stdout.write(`zotero-agent-mcp ${VERSION}\n`);
  process.exit(0);
}
if (CLI.help) {
  process.stdout.write(
    [
      `zotero-agent-mcp v${VERSION} — MCP stdio bridge for Zotero-Agent-MCP`,
      ``,
      `Usage:`,
      `  zotero-agent-mcp [--token <TOKEN>] [--url <URL>] [--tools full|core]`,
      `  npx --prefer-offline -y zotero-agent-mcp --token <TOKEN>`,
      `  zotero-agent-mcp --selftest      # one-shot connectivity check, prints JSON`,
      ``,
      `Options:`,
      `  -t, --token <TOKEN>  Bearer token from Zotero Settings → Zotero-Agent-MCP (or env ZOTERO_AGENT_TOKEN)`,
      `  -u, --url <URL>      Plugin base URL (default: http://127.0.0.1:23119/zotero-agent-mcp)`,
      `      --tools <set>    "full" (default, 34 tools) or "core" (13 tools, smaller context)`,
      `  -v, --version        Print version and exit`,
      `  -h, --help           Show this help and exit`,
    ].join("\n") + "\n"
  );
  process.exit(0);
}

const BASE_URL = (CLI.url || process.env.ZOTERO_AGENT_URL || "http://127.0.0.1:23119/zotero-agent-mcp").replace(/\/+$/, "");
const TOKEN = CLI.token || process.env.ZOTERO_AGENT_TOKEN || readFallbackToken();
const TOOL_SET = String(CLI.tools || process.env.ZOTERO_AGENT_TOOLS || "full").toLowerCase() === "core" ? "core" : "full";

function log(msg) {
  process.stderr.write(`[zotero-agent-mcp] ${msg}\n`);
}

async function api(path, { method = "GET", query = {}, body } = {}) {
  const u = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "X-Agent-Token": TOKEN,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(u, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Cannot reach Zotero AgentMCP at ${BASE_URL} — is Zotero running with the plugin enabled? (${e.message})`);
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    json = { error: "bad_response", message: `HTTP ${res.status} with non-JSON body` };
  }
  if (!res.ok) {
    const err = new Error(json.message || `HTTP ${res.status}`);
    err.apiStatus = res.status;
    err.apiError = json.error || "error";
    err.apiBody = json;
    throw err;
  }
  return json;
}
// ---------- schema helpers (every byte here lands in the model's context) ----------
const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };
const A = { type: "array", items: { type: "string" } };
const O = { type: "object", additionalProperties: { type: "string" } };
const CA = { type: "array", items: { type: "object" } };
const LIB = { type: "string", description: "user|id|all" };
const KEY = { type: "string", description: "8-char key" };

// MCP annotation defaults are conservative (destructiveHint/openWorldHint default true,
// readOnlyHint default false), so only the non-default cases are spelled out.
const RO = { readOnlyHint: true };
const WD = { destructiveHint: false };
const DEL = { readOnlyHint: false, destructiveHint: true };

const TOOLS_ALL = [
  {
    name: "zotero_ping",
    description: "Check reachability, version, scopes.",
    annotations: RO,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "zotero_libraries",
    description: "List libraries (personal+groups).",
    annotations: RO,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "zotero_collections",
    description: "List a library's collection tree.",
    annotations: RO,
    inputSchema: { type: "object", properties: { library: LIB } },
  },
  {
    name: "zotero_search",
    description: "Search title/creator/year; everything adds fulltext.",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: {
        query: S,
        library: LIB,
        mode: { type: "string", description: "title|everything" },
        tag: S,
        item_type: { type: "string", description: "e.g. journalArticle" },
        limit: { type: "number", description: "default 25" },
        offset: N,
      },
      required: ["query"],
    },
  },
  {
    name: "zotero_recent",
    description: "Recent modified items.",
    annotations: RO,
    inputSchema: { type: "object", properties: { library: LIB, limit: N } },
  },
  {
    name: "zotero_get_item",
    description: "Item metadata: creators, tags, children, attachment.",
    annotations: RO,
    inputSchema: { type: "object", properties: { key: KEY, library: LIB }, required: ["key"] },
  },
  {
    name: "zotero_get_fulltext",
    description: "Read attachment text; paginate via offset/max.",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "item/attachment key" },
        library: LIB,
        offset: { type: "number", description: "nextOffset from previous call" },
        max_chars: { type: "number", description: "default 200000" },
      },
      required: ["key"],
    },
  },
  {
    name: "zotero_get_annotations",
    description: "Highlights and annotation comments (color, page, comment).",
    annotations: RO,
    inputSchema: { type: "object", properties: { key: KEY, library: LIB }, required: ["key"] },
  },
  {
    name: "zotero_get_children",
    description: "List child attachments and child notes.",
    annotations: RO,
    inputSchema: { type: "object", properties: { key: KEY, library: LIB }, required: ["key"] },
  },
  {
    name: "zotero_cite",
    description: "Format a citation (CSL) or export bibtex/ris/csljson.",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: {
        key: KEY,
        library: LIB,
        format: { type: "string", description: "bibliography (default)|citation|bibtex|ris|csv|…" },
        style: { type: "string", description: "default apa" },
      },
      required: ["key"],
    },
  },
  {
    name: "zotero_add_item",
    description: "Create an item from a file or metadata.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "absolute path" },
        title: S,
        item_type: { type: "string", description: "default document" },
        fields: O,
        creators: CA,
        collections: A,
        tags: A,
        mode: { type: "string", description: "import (default)|link" },
        parent_key: { type: "string", description: "attach file to this item" },
        library: LIB,
        recognize: B,
      },
    },
  },
  {
    name: "zotero_set_item_collections",
    description: "Replace/add/remove collection membership.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        key: KEY,
        collections: { type: "array", items: { type: "string" }, description: "empty+replace clears" },
        mode: { type: "string", description: "replace (default)|add|remove" },
        library: LIB,
      },
      required: ["key", "collections"],
    },
  },
  {
    name: "zotero_update_item",
    description: "Update metadata, creators, tags, collections, trash.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        key: KEY,
        title: S,
        fields: O,
        creators: CA,
        tags: A,
        collections: { type: "array", items: { type: "string" }, description: "[] unfiles" },
        note: { type: "string", description: "note items only" },
        deleted: { type: "boolean", description: "true = trash" },
        version: N,
        library: LIB,
      },
      required: ["key"],
    },
  },
  {
    name: "zotero_delete_item",
    description: "Trash an item; permanent=true erases it.",
    annotations: DEL,
    inputSchema: {
      type: "object",
      properties: {
        key: KEY,
        permanent: B,
        library: LIB,
      },
      required: ["key"],
    },
  },
  {
    name: "zotero_get_trash",
    description: "List trashed items.",
    annotations: RO,
    inputSchema: { type: "object", properties: { library: LIB, limit: N } },
  },
  {
    name: "zotero_attach_file",
    description: "Attach a local file to an item (import|link).",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "parent key" },
        path: S,
        mode: { type: "string", description: "import (default)|link" },
        title: S,
        recognize: B,
        library: LIB,
      },
      required: ["key", "path"],
    },
  },
  {
    name: "zotero_get_attachment_path",
    description: "Local filesystem path of an item's attachment.",
    annotations: RO,
    inputSchema: { type: "object", properties: { key: KEY, library: LIB }, required: ["key"] },
  },
  {
    name: "zotero_create_collection",
    description: "Create a collection, optionally nested.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        name: S,
        parent: { type: "string", description: "parent key/name; omit for top" },
        library: LIB,
      },
      required: ["name"],
    },
  },
  {
    name: "zotero_update_collection",
    description: "Rename, move or trash a collection.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "collection key" },
        name: S,
        parent: { type: ["string", "null"], description: "null = top level" },
        deleted: B,
        library: LIB,
      },
      required: ["key"],
    },
  },
  {
    name: "zotero_delete_collection",
    description: "Delete a collection; items only unfiled.",
    annotations: DEL,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "collection key" },
        permanent: B,
        library: LIB,
      },
      required: ["key"],
    },
  },
  {
    name: "zotero_search_collections",
    description: "Find collections by name.",
    annotations: RO,
    inputSchema: { type: "object", properties: { query: S, library: LIB }, required: ["query"] },
  },
  {
    name: "zotero_get_collection_items",
    description: "List items in a collection.",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "collection key or name" }, library: LIB, limit: N },
      required: ["key"],
    },
  },
  {
    name: "zotero_get_tags",
    description: "List all tags used in a library.",
    annotations: RO,
    inputSchema: { type: "object", properties: { library: LIB } },
  },
  {
    name: "zotero_delete_tags",
    description: "Remove tags library-wide (max 50 per call).",
    annotations: DEL,
    inputSchema: {
      type: "object",
      properties: { tags: A, library: LIB },
      required: ["tags"],
    },
  },
  {
    name: "zotero_get_searches",
    description: "List saved searches.",
    annotations: RO,
    inputSchema: { type: "object", properties: { library: LIB } },
  },
  {
    name: "zotero_create_search",
    description: "Create a saved search from {condition,operator,value} triples.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        name: S,
        conditions: { type: "array", items: { type: "object" }, description: "e.g. {condition,operator,value}" },
        library: LIB,
      },
      required: ["name", "conditions"],
    },
  },
  {
    name: "zotero_update_search",
    description: "Update a saved search's name/conditions.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "search key" },
        name: S,
        conditions: { type: "array", items: { type: "object" }, description: "full replacement" },
        library: LIB,
      },
      required: ["key"],
    },
  },
  {
    name: "zotero_delete_search",
    description: "Delete a saved search.",
    annotations: DEL,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "saved search key" }, library: LIB },
      required: ["key"],
    },
  },
  {
    name: "zotero_run_search",
    description: "Run a saved search and return matching items.",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "saved search key" }, library: LIB, limit: N },
      required: ["key"],
    },
  },
  {
    name: "zotero_get_schema",
    description: "Introspect valid field/creator names.",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: { item_type: { type: "string", description: "e.g. journalArticle" } },
    },
  },
  {
    name: "zotero_versions",
    description: "Object versions for incremental sync.",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "items (default)|collections|searches|fulltext" },
        since: { type: "number", description: "greater than this" },
        library: LIB,
      },
    },
  },
  {
    name: "zotero_set_fulltext",
    description: "Write text into an attachment's fulltext index.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "item or attachment key" },
        content: { type: "string", description: "text to index" },
        library: LIB,
      },
      required: ["key", "content"],
    },
  },
  {
    name: "zotero_add_note",
    description: "Add a child note to an item.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "parent item key" },
        html: { type: "string", description: "text or simple HTML" },
        library: LIB,
      },
      required: ["key", "html"],
    },
  },
  {
    name: "zotero_add_tag",
    description: "Add or remove a single tag on an item.",
    annotations: WD,
    inputSchema: {
      type: "object",
      properties: {
        key: KEY,
        tag: S,
        action: { type: "string", description: "add (default)|remove" },
        library: LIB,
      },
      required: ["key", "tag"],
    },
  },
];

const CORE_TOOLS = new Set([
  "zotero_ping",
  "zotero_libraries",
  "zotero_collections",
  "zotero_search",
  "zotero_recent",
  "zotero_get_item",
  "zotero_get_fulltext",
  "zotero_get_annotations",
  "zotero_get_children",
  "zotero_cite",
  "zotero_add_item",
  "zotero_update_item",
  "zotero_set_item_collections",
]);

const TOOLS = TOOL_SET === "core" ? TOOLS_ALL.filter((t) => CORE_TOOLS.has(t.name)) : TOOLS_ALL;
// Serialize once: tools/list is sent on every client connect and must stay cheap.
const TOOLS_RESULT_JSON = JSON.stringify({ tools: TOOLS });

async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case "zotero_ping":
      return api("/ping");
    case "zotero_libraries":
      return api("/libraries");
    case "zotero_collections":
      return api("/collections", { query: { library: args.library } });
    case "zotero_search":
      return api("/search", {
        query: {
          q: args.query,
          library: args.library,
          mode: args.mode,
          tag: args.tag,
          itemType: args.item_type,
          limit: args.limit,
          offset: args.offset,
        },
      });
    case "zotero_recent":
      return api("/items/recent", { query: { library: args.library, limit: args.limit } });
    case "zotero_get_item":
      return api(`/item/${encodeURIComponent(args.key)}`, { query: { library: args.library } });
    case "zotero_get_fulltext":
      return api(`/item/${encodeURIComponent(args.key)}/fulltext`, {
        query: { library: args.library, offset: args.offset, maxChars: args.max_chars },
      });
    case "zotero_get_annotations":
      return api(`/item/${encodeURIComponent(args.key)}/annotations`, { query: { library: args.library } });
    case "zotero_get_children":
      return api(`/item/${encodeURIComponent(args.key)}/children`, { query: { library: args.library } });
    case "zotero_cite":
      return api(`/item/${encodeURIComponent(args.key)}/cite`, {
        query: { library: args.library, format: args.format, style: args.style },
      });
    case "zotero_add_item":
      return api("/item", {
        method: "POST",
        body: {
          path: args.path,
          title: args.title,
          itemType: args.item_type,
          fields: args.fields,
          creators: args.creators,
          collections: args.collections,
          tags: args.tags,
          mode: args.mode,
          parentKey: args.parent_key,
          library: args.library,
          recognize: args.recognize,
        },
      });
    case "zotero_set_item_collections":
      return api(`/item/${encodeURIComponent(args.key)}/collections`, {
        method: "POST",
        body: { collections: args.collections, mode: args.mode, library: args.library },
      });
    case "zotero_update_item":
      return api(`/item/${encodeURIComponent(args.key)}/update`, {
        method: "POST",
        body: {
          title: args.title,
          fields: args.fields,
          creators: args.creators,
          tags: args.tags,
          collections: args.collections,
          note: args.note,
          deleted: args.deleted,
          version: args.version,
          library: args.library,
        },
      });
    case "zotero_delete_item":
      return api(`/item/${encodeURIComponent(args.key)}/delete`, {
        method: "POST",
        body: { permanent: args.permanent, library: args.library },
      });
    case "zotero_get_trash":
      return api("/items/trash", { query: { library: args.library, limit: args.limit } });
    case "zotero_attach_file":
      return api(`/item/${encodeURIComponent(args.key)}/attach`, {
        method: "POST",
        body: { path: args.path, mode: args.mode, title: args.title, recognize: args.recognize, library: args.library },
      });
    case "zotero_get_attachment_path":
      return api(`/item/${encodeURIComponent(args.key)}/path`, { query: { library: args.library } });
    case "zotero_create_collection":
      return api("/collection", {
        method: "POST",
        body: { name: args.name, parent: args.parent, library: args.library },
      });
    case "zotero_update_collection":
      return api(`/collection/${encodeURIComponent(args.key)}/update`, {
        method: "POST",
        body: { name: args.name, parent: args.parent, deleted: args.deleted, library: args.library },
      });
    case "zotero_delete_collection":
      return api(`/collection/${encodeURIComponent(args.key)}/delete`, {
        method: "POST",
        body: { permanent: args.permanent, library: args.library },
      });
    case "zotero_search_collections":
      return api("/collections/search", { query: { q: args.query, library: args.library } });
    case "zotero_get_collection_items":
      return api(`/collection/${encodeURIComponent(args.key)}/items`, { query: { library: args.library, limit: args.limit } });
    case "zotero_get_tags":
      return api("/tags", { query: { library: args.library } });
    case "zotero_delete_tags":
      return api("/tags/delete", { method: "POST", body: { tags: args.tags, library: args.library } });
    case "zotero_get_searches":
      return api("/searches", { query: { library: args.library } });
    case "zotero_create_search":
      return api("/searches", { method: "POST", body: { name: args.name, conditions: args.conditions, library: args.library } });
    case "zotero_update_search":
      return api(`/search/${encodeURIComponent(args.key)}/update`, {
        method: "POST",
        body: { name: args.name, conditions: args.conditions, library: args.library },
      });
    case "zotero_delete_search":
      return api(`/search/${encodeURIComponent(args.key)}/delete`, { method: "POST", body: { library: args.library } });
    case "zotero_run_search":
      return api(`/search/${encodeURIComponent(args.key)}/items`, { query: { library: args.library, limit: args.limit } });
    case "zotero_get_schema":
      return api("/schema", { query: { itemType: args.item_type } });
    case "zotero_versions":
      return api("/versions", { query: { type: args.type, since: args.since, library: args.library } });
    case "zotero_set_fulltext":
      return api(`/item/${encodeURIComponent(args.key)}/fulltext/set`, {
        method: "POST",
        body: { content: args.content, library: args.library },
      });
    case "zotero_add_note":
      return api("/note", {
        method: "POST",
        body: { itemKey: args.key, html: args.html, library: args.library },
      });
    case "zotero_add_tag":
      return api("/tag", {
        method: "POST",
        body: { itemKey: args.key, tag: args.tag, action: args.action, library: args.library },
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Compact JSON: responses are fed straight into a model context, so indentation is pure cost.
function textContent(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] };
}
function errorContent(e) {
  return {
    content: [{ type: "text", text: `Error${e.apiStatus ? ` (HTTP ${e.apiStatus}, ${e.apiError})` : ""}: ${e.message}` }],
    isError: true,
  };
}

function writeRaw(json) {
  process.stdout.write(json + "\n");
}
function respond(id, result) {
  writeRaw(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${JSON.stringify(result)}}`);
}
function respondError(id, code, message) {
  writeRaw(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"error":${JSON.stringify({ code, message })}}`);
}

// One-shot connectivity check used by the settings pane's "连接测试" button:
// verifies node + bridge file + token + the plugin's HTTP surface in one process.
if (process.argv.slice(2).includes("--selftest")) {
  const t0 = Date.now();
  const out = {
    ok: false,
    version: VERSION,
    tools: TOOLS.length,
    toolSet: TOOL_SET,
    url: BASE_URL,
    tokenPresent: !!TOKEN,
    httpMs: 0,
    totalMs: 0,
    error: null,
  };
  try {
    const ping = await api("/ping");
    out.httpMs = Date.now() - t0;
    out.ok = !!(ping && ping.plugin === "zotero-agent-mcp");
    out.enabled = ping ? ping.enabled : null;
    out.scopes = ping ? ping.scopes : null;
    out.pluginVersion = ping ? ping.version : null;
    if (!out.ok) out.error = "unexpected /ping payload";
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  out.totalMs = Date.now() - t0;
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(out.ok ? 0 : 1);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch (e) {
    log(`unparseable message: ${s.slice(0, 200)}`);
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) {
    // notification — nothing to answer
    return;
  }
  try {
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "zotero-agent-mcp", version: VERSION },
        });
        break;
      case "ping":
        respond(id, {});
        break;
      case "tools/list":
        writeRaw(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${TOOLS_RESULT_JSON}}`);
        break;
      case "prompts/list":
        respond(id, { prompts: [] });
        break;
      case "resources/list":
        respond(id, { resources: [] });
        break;
      case "tools/call": {
        const toolName = params?.name;
        try {
          const result = await callTool(toolName, params?.arguments);
          respond(id, textContent(result));
        } catch (e) {
          log(`tool ${toolName} failed: ${e.message}`);
          respond(id, errorContent(e));
        }
        break;
      }
      default:
        respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log(`handler error: ${e.stack || e}`);
    respondError(id, -32603, String(e.message || e));
  }
});

rl.on("close", () => process.exit(0));
log(`bridge ready — ${BASE_URL} (token ${TOKEN ? TOKEN.slice(0, 4) + "…" : "MISSING"}, ${TOOLS.length} tools, set=${TOOL_SET})`);
