#!/usr/bin/env node
/* zotero-agent MCP bridge — zero-dependency Model Context Protocol server over stdio.
 * Released by "Zotero-Agent-MCP" to <Zotero data dir>/zotero-agent-mcp/zotero-agent-mcp.mjs.
 *
 * Config (env):
 *   ZOTERO_AGENT_URL   default http://127.0.0.1:23119/zotero-agent-mcp
 *   ZOTERO_AGENT_TOKEN bearer token from Zotero Settings → AgentMCP
 *
 * Protocol: newline-delimited JSON-RPC 2.0 (MCP stdio transport).
 * All diagnostics go to stderr; stdout carries only protocol messages.
 */

import readline from "node:readline";

const BASE_URL = (process.env.ZOTERO_AGENT_URL || "http://127.0.0.1:23119/zotero-agent-mcp").replace(/\/+$/, "");
const TOKEN = process.env.ZOTERO_AGENT_TOKEN || "";
const VERSION = "0.2.0";

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

function str(schema) {
  return { type: "string", description: schema };
}
function num(schema) {
  return { type: "number", description: schema };
}
function bool(schema) {
  return { type: "boolean", description: schema };
}

const LIBRARY_PARAM = str("Library: 'user' (default) or numeric libraryID from zotero_libraries");

const TOOLS = [
  {
    name: "zotero_ping",
    description:
      "Check that the Zotero AgentMCP plugin is reachable. Returns plugin/Zotero versions, enabled permission scopes, and available libraries. Call this first if other zotero tools fail.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "zotero_libraries",
    description: "List available Zotero libraries (personal library + groups) with libraryID, type, name, editability.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "zotero_collections",
    description: "List the collection tree of a Zotero library.",
    inputSchema: {
      type: "object",
      properties: { library: LIBRARY_PARAM },
      additionalProperties: false,
    },
  },
  {
    name: "zotero_search",
    description:
      "Search Zotero items. Default mode searches titles/creators/year; mode='everything' searches all fields, notes and fulltext. Returns metadata summaries; follow up with zotero_get_item / zotero_get_fulltext / zotero_get_annotations.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Search text (required)"),
        library: str("'user', numeric libraryID, or 'all' to search every library"),
        mode: str("'title' (default, quicksearch title/creator/year) or 'everything'"),
        tag: str("Filter by exact tag"),
        item_type: str("Filter by item type, e.g. journalArticle, book"),
        limit: num("Max results 1-100 (default 25)"),
        offset: num("Pagination offset"),
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_recent",
    description: "List recently modified top-level items in a library.",
    inputSchema: {
      type: "object",
      properties: { library: LIBRARY_PARAM, limit: num("Max results (default 20)") },
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_item",
    description:
      "Get full metadata of one item by key (title, creators, abstract, tags, date, DOI, children summary, best attachment key).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("8-character Zotero item key, e.g. 'ABCD1234'"),
        library: LIBRARY_PARAM,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_fulltext",
    description:
      "Read the extracted text of an item's attachment (PDF/EPUB/text). Works with a top-level item key (uses its best PDF) or an attachment key. Supports pagination for long documents.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key (top-level item or attachment)"),
        library: LIBRARY_PARAM,
        offset: num("Character offset to start reading (use nextOffset from a previous call)"),
        max_chars: num("Max characters to return (default 200000)"),
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_annotations",
    description: "Get the user's highlights and annotation comments (with colors, pages, comments) for an item.",
    inputSchema: {
      type: "object",
      properties: { key: str("Zotero item key"), library: LIBRARY_PARAM },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_children",
    description: "List child attachments and child notes of an item.",
    inputSchema: {
      type: "object",
      properties: { key: str("Zotero item key"), library: LIBRARY_PARAM },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_cite",
    description:
      "Render a citation/bibliography for an item: formatted bibliography or in-text citation in any installed CSL style (e.g. 'apa', 'chinese-gb7714-2005-numeric'), or BibTeX source.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key"),
        library: LIBRARY_PARAM,
        format: str("'bibliography' (default) | 'citation' | 'bibtex'"),
        style: str("CSL style id, default 'apa'"),
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_add_item",
    description:
      "Create a new Zotero item from a LOCAL file (PDF/EPUB/DOCX/TXT/…) and attach the file, optionally filing it into collections and running Zotero's automatic metadata recognition. mode='import' copies the file into Zotero storage (default); mode='link' references the original path. If parentKey is given, attaches to that existing item instead of creating a new one.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Absolute local file path, e.g. /Users/me/papers/foo.pdf"),
        title: str("Item title (defaults to the file name without extension)"),
        item_type: str("Zotero item type, default 'document'; e.g. journalArticle, book, report, thesis"),
        collections: { type: "array", items: { type: "string" }, description: "Collection keys or exact collection names to file the item into" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to add to the new item" },
        mode: str("'import' (default, copy file) or 'link' (attach original path)"),
        parent_key: str("Attach to this existing item instead of creating a new one"),
        library: LIBRARY_PARAM,
        recognize: bool("Run Zotero's automatic metadata retrieval on the attachment (best effort)"),
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_add_note",
    description:
      "Add a child note to an item (plain text or simple HTML). Requires the plugin's 'write' scope to be enabled in Zotero Settings → AgentMCP.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key of the parent item"),
        html: str("Note body (text or simple HTML)"),
        library: LIBRARY_PARAM,
      },
      required: ["key", "html"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_add_tag",
    description:
      "Add or remove a tag on an item. Requires the plugin's 'write' scope to be enabled in Zotero Settings → AgentMCP.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key"),
        tag: str("Tag text"),
        action: str("'add' (default) or 'remove'"),
        library: LIBRARY_PARAM,
      },
      required: ["key", "tag"],
      additionalProperties: false,
    },
  },
];

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
          collections: args.collections,
          tags: args.tags,
          mode: args.mode,
          parentKey: args.parent_key,
          library: args.library,
          recognize: args.recognize,
        },
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

function textContent(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function errorContent(e) {
  return {
    content: [{ type: "text", text: `Error${e.apiStatus ? ` (HTTP ${e.apiStatus}, ${e.apiError})` : ""}: ${e.message}` }],
    isError: true,
  };
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
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
        respond(id, { tools: TOOLS });
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
log(`bridge ready — ${BASE_URL} (token ${TOKEN ? TOKEN.slice(0, 4) + "…" : "MISSING"}, ${TOOLS.length} tools)`);
