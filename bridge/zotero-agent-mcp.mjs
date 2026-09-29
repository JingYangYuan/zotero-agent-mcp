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
const VERSION = "0.5.0";

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
      "Render a citation/bibliography for an item, or export it in a standard format: formatted bibliography or in-text citation in any installed CSL style (e.g. 'apa', 'chinese-gb7714-2005-numeric'), or a full export format (bibtex, biblatex, ris, csljson, csv, mods, refer, tei, wikipedia, marc).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key"),
        library: LIBRARY_PARAM,
        format: str("'bibliography' (default) | 'citation' | 'bibtex' | 'biblatex' | 'ris' | 'csljson' | 'csv' | 'mods' | 'refer' | 'tei' | 'wikipedia' | 'marc'"),
        style: str("CSL style id, default 'apa'"),
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_add_item",
    description:
      "Create a new Zotero item. Either from a LOCAL file (path is attached; PDF/EPUB/DOCX/TXT/…; mode='import' copies into Zotero storage, mode='link' references the original path) or — since v0.5.0 — WITHOUT a file as pure metadata (omit path; typical for literature ingest). Full bibliographic metadata: fields map + creators + collections + tags in one call. If parentKey is given (requires path), attaches the file to that existing item instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Absolute local file path, e.g. /Users/me/papers/foo.pdf — omit for a pure-metadata item"),
        title: str("Item title (defaults to the file name without extension)"),
        item_type: str("Zotero item type, default 'document'; e.g. journalArticle, book, report, thesis"),
        fields: { type: "object", additionalProperties: { type: "string" }, description: "Zotero field names to values, e.g. {date:'2020', publicationTitle:'社会学研究', abstractNote:'…', DOI:'…', volume, issue, pages, extra} — run zotero_get_schema to see valid fields per type" },
        creators: { type: "array", items: { type: "object", additionalProperties: true }, description: "Zotero creators, e.g. [{name:'张成刚', creatorType:'author'}] or [{firstName:'Alex J', lastName:'Wood', creatorType:'author'}]" },
        collections: { type: "array", items: { type: "string" }, description: "Collection keys or exact collection names to file the item into" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to add to the new item" },
        mode: str("'import' (default, copy file) or 'link' (attach original path)"),
        parent_key: str("Attach the file to this existing item instead of creating a new one (requires path)"),
        library: LIBRARY_PARAM,
        recognize: bool("Run Zotero's automatic metadata retrieval on the attachment (best effort)"),
      },
      additionalProperties: false,
    },
  },
  {
    name: "zotero_set_item_collections",
    description:
      "Change which collections an item belongs to: replace the full membership list (default), add to collections, or remove from collections. Collections are matched by collection key or exact name (nested subcollections included). Requires the plugin's 'write' scope to be enabled in Zotero Settings → AgentMCP.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key"),
        collections: { type: "array", items: { type: "string" }, description: "Collection keys or exact collection names; empty array with mode='replace' clears membership" },
        mode: str("'replace' (default, set the full list), 'add' or 'remove'"),
        library: LIBRARY_PARAM,
      },
      required: ["key", "collections"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_update_item",
    description:
      "Update an existing item's metadata: title, any fields, creators, tags (replaces the full set), collections (replaces the full set; empty array unfiles it), note body (for notes), and trash state (deleted: true/false). Invalid field names are skipped and reported in skippedFields. The optional 'version' is informational only (Zotero assigns versions asynchronously after local saves, so no strict conflict check is possible).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key"),
        title: str("New title"),
        fields: { type: "object", additionalProperties: { type: "string" }, description: "Field names to new values, e.g. {date:'2021', volume:'28', pages:'31-40'}" },
        creators: { type: "array", items: { type: "object", additionalProperties: true }, description: "Full replacement creator list, same format as zotero_add_item" },
        tags: { type: "array", items: { type: "string" }, description: "Full replacement tag list" },
        collections: { type: "array", items: { type: "string" }, description: "Full replacement list of collection keys or exact names; [] removes from all collections" },
        note: str("New note body (only for note items)" ),
        deleted: bool("true = move to trash, false = restore from trash"),
        version: num("Version from a prior read, for conflict detection (optional)"),
        library: LIBRARY_PARAM,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_delete_item",
    description:
      "Delete an item. By default moves it to the Zotero trash (recoverable via zotero_update_item {deleted: false}); permanent=true erases it for good. Use trash first unless the user explicitly asks for permanent deletion.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key"),
        permanent: bool("Skip the trash and erase permanently (default false)"),
        library: LIBRARY_PARAM,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_trash",
    description: "List items currently in the trash of a library (most recently deleted first).",
    inputSchema: {
      type: "object",
      properties: { library: LIBRARY_PARAM, limit: num("Max results (default 50)") },
      additionalProperties: false,
    },
  },
  {
    name: "zotero_attach_file",
    description:
      "Attach a local file (PDF etc.) to an existing item. mode='import' copies the file into Zotero storage (default); mode='link' references the original path.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key of the parent item"),
        path: str("Absolute local file path"),
        mode: str("'import' (default) or 'link'"),
        title: str("Attachment title (optional)"),
        recognize: bool("Run Zotero's automatic metadata retrieval (best effort)"),
        library: LIBRARY_PARAM,
      },
      required: ["key", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_attachment_path",
    description: "Get the absolute local filesystem path of an item's attachment (locates the original file on disk).",
    inputSchema: {
      type: "object",
      properties: { key: str("Zotero item key (top-level item or attachment)"), library: LIBRARY_PARAM },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_create_collection",
    description: "Create a collection, optionally as a subcollection of an existing one (match parent by key or exact name).",
    inputSchema: {
      type: "object",
      properties: {
        name: str("New collection name"),
        parent: str("Parent collection key or exact name (omit for top level)"),
        library: LIBRARY_PARAM,
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_update_collection",
    description:
      "Update a collection: rename (name), move under a different parent (parent = key/exact name, or null to move to top level), or trash/restore it (deleted).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Collection key"),
        name: str("New name"),
        parent: { type: ["string", "null"], description: "New parent collection key or exact name; null moves the collection to top level" },
        deleted: bool("true = trash, false = restore"),
        library: LIBRARY_PARAM,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_delete_collection",
    description:
      "Delete a collection. Default moves it to trash; permanent=true erases it (member items are only unfiled, never deleted).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Collection key"),
        permanent: bool("Erase permanently instead of trashing (default false)"),
        library: LIBRARY_PARAM,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_search_collections",
    description: "Search collections by name (substring, case-insensitive). Returns keys with their full parent path — use before zotero_get_collection_items or when filing items.",
    inputSchema: {
      type: "object",
      properties: { query: str("Name fragment to search for"), library: LIBRARY_PARAM },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_collection_items",
    description: "List the items in a collection (by collection key or exact name).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Collection key or exact name"),
        library: LIBRARY_PARAM,
        limit: num("Max results (default 50)"),
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_tags",
    description: "List all tags used in a library.",
    inputSchema: {
      type: "object",
      properties: { library: LIBRARY_PARAM },
      additionalProperties: false,
    },
  },
  {
    name: "zotero_delete_tags",
    description:
      "Delete tags library-wide (removes the tag from every item). Provide exact tag names, max 50 per call.",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "Exact tag names to remove library-wide" },
        library: LIBRARY_PARAM,
      },
      required: ["tags"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_searches",
    description: "List saved searches in a library (key, name, version).",
    inputSchema: {
      type: "object",
      properties: { library: LIBRARY_PARAM },
      additionalProperties: false,
    },
  },
  {
    name: "zotero_create_search",
    description:
      "Create a saved search. Conditions use Zotero search condition/operator/value triples, e.g. {condition:'tag', operator:'is', value:'单位制'} or {condition:'quicksearch-titleCreatorYear', operator:'contains', value:'平台'}. Combine with joinMode any/all via a {condition:'joinMode', operator:'is', value:'any'} condition.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("Saved search name"),
        conditions: { type: "array", items: { type: "object", additionalProperties: true }, description: "[{condition, operator, value}]" },
        library: LIBRARY_PARAM,
      },
      required: ["name", "conditions"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_update_search",
    description: "Update a saved search's name and/or conditions (conditions replace the full list).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Saved search key"),
        name: str("New name"),
        conditions: { type: "array", items: { type: "object", additionalProperties: true }, description: "Full replacement [{condition, operator, value}]" },
        library: LIBRARY_PARAM,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_delete_search",
    description: "Delete a saved search.",
    inputSchema: {
      type: "object",
      properties: { key: str("Saved search key"), library: LIBRARY_PARAM },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_run_search",
    description: "Execute a saved search and return the matching items (a capability even the Zotero web API lacks).",
    inputSchema: {
      type: "object",
      properties: { key: str("Saved search key"), library: LIBRARY_PARAM, limit: num("Max results (default 50)") },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_get_schema",
    description:
      "Introspect valid Zotero field names: with itemType, returns that type's fields and creator types; without, lists all item types. Use before zotero_add_item/zotero_update_item to get field names right (invalid names are silently skipped).",
    inputSchema: {
      type: "object",
      properties: { item_type: str("e.g. journalArticle, book — omit to list all types" ) },
      additionalProperties: false,
    },
  },
  {
    name: "zotero_versions",
    description:
      "Incremental sync aid: returns object versions (key → version) for items/collections/searches/fulltext changed since a given version, plus the current library version. Cache across sessions: store libraryVersion, next call pass since=storedValue.",
    inputSchema: {
      type: "object",
      properties: {
        type: str("'items' (default) | 'collections' | 'searches' | 'fulltext'"),
        since: num("Only objects with version greater than this (default 0 = all)"),
        library: LIBRARY_PARAM,
      },
      additionalProperties: false,
    },
  },
  {
    name: "zotero_set_fulltext",
    description:
      "Write plain-text content into an attachment's full-text index, making it searchable via mode='everything'. Use for text the agent produced or extracted externally (e.g. OCR).",
    inputSchema: {
      type: "object",
      properties: {
        key: str("Zotero item key (top-level item or attachment)"),
        content: str("Plain text to index"),
        library: LIBRARY_PARAM,
      },
      required: ["key", "content"],
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
