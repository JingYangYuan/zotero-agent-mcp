#!/usr/bin/env node
/* Offline unit + mock-HTTP bridge E2E tests for v0.6.3 pagination, filtering, and compact mode. */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BRIDGE = path.join(ROOT, "bridge", "zotero-agent-mcp.mjs");
const PLUGIN_JS = path.join(ROOT, "plugin", "zotero-agent-mcp.js");
const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "bench-baseline.json"), "utf8"));

// 1. Unit test helper functions extracted from plugin/zotero-agent-mcp.js
{
  const src = fs.readFileSync(PLUGIN_JS, "utf8");
  const startMarker = "  const COMPACT_ITEM_FIELDS = new Set([";
  const endMarker = "  function clampInt(";
  const helperStart = src.indexOf("  function boolParam(v)");
  const helperEnd = src.indexOf("  async function itemToJSON") >= 0
    ? src.indexOf("  function sortItemsDesc(items)")
    : -1;
  assert.ok(src.indexOf(startMarker) > 0, "COMPACT_ITEM_FIELDS must exist in plugin/zotero-agent-mcp.js");
  assert.ok(src.indexOf(endMarker) > 0, "clampInt must exist");
  assert.ok(helperStart > 0 && helperEnd > helperStart, "pagination helpers must exist");

  const compactBlock = src.slice(src.indexOf(startMarker), src.indexOf("  // ---------- search ----------"));
  const helperBlock = src.slice(src.indexOf("  function clampInt("), src.indexOf("  // ---------- tags / collections"));
  // Isolate pure helper slice between clampInt and end of sortItemsDesc
  const sortEnd = src.indexOf("\n  }\n", src.indexOf("  function sortItemsDesc(items)")) + 4;
  const pureHelpers = src.slice(src.indexOf("  function clampInt("), sortEnd);

  const ancStart = src.indexOf("  function expandCollectionAncestors(ids, byID)");
  const ancEnd = src.indexOf("  function ancestorCollectionIDs(");
  assert.ok(ancStart > 0 && ancEnd > ancStart, "expandCollectionAncestors must exist");
  const ancHelpers = src.slice(ancStart, ancEnd);

  const ctx = {
    Zotero: { Libraries: { getName: () => "My Library" } },
  };
  vm.runInNewContext(
    compactBlock + "\n" + pureHelpers + "\n" + ancHelpers + "\nthis.__exports = { itemToJSON, clampInt, boolParam, parseLimit, parseOffset, pageMeta, sortItemsDesc, expandCollectionAncestors };",
    ctx
  );
  const { itemToJSON, boolParam, parseLimit, parseOffset, pageMeta, sortItemsDesc, expandCollectionAncestors } = ctx.__exports;

  const plain = (x) => JSON.parse(JSON.stringify(x));

  // Test ancestor propagation (subcollection -> level 1 top collection)
  const colTree = new Map([
    [1, { id: 1, parentID: 0 }],
    [2, { id: 2, parentID: 1 }],
    [3, { id: 3, parentID: 2 }],
    [4, { id: 4, parentID: 2 }],
  ]);
  assert.deepEqual(plain(expandCollectionAncestors([3], colTree)), [3, 2, 1]);
  assert.deepEqual(plain(expandCollectionAncestors([3, 4], colTree)), [3, 2, 1, 4]);
  assert.deepEqual(plain(expandCollectionAncestors([1], colTree)), [1]);
  const cyclicTree = new Map([
    [10, { id: 10, parentID: 20 }],
    [20, { id: 20, parentID: 10 }],
  ]);
  assert.deepEqual(plain(expandCollectionAncestors([10], cyclicTree)), [10, 20]);

  assert.equal(boolParam(true), true);
  assert.equal(boolParam("true"), true);
  assert.equal(boolParam("1"), true);
  assert.equal(boolParam("false"), false);
  assert.equal(boolParam(null), false);

  const p1 = new URLSearchParams("limit=9999&offset=120");
  assert.equal(parseLimit(p1, 25, 500, false), 500);
  assert.equal(parseLimit(p1, 25, 500, true), 1000);
  assert.equal(parseOffset(p1), 120);
  assert.equal(parseOffset(new URLSearchParams("offset=-5")), 0);

  assert.deepEqual(plain(pageMeta(250, 0, 100, 100)), { total: 250, offset: 0, limit: 100, hasMore: true, nextOffset: 100 });
  assert.deepEqual(plain(pageMeta(250, 200, 100, 50)), { total: 250, offset: 200, limit: 100, hasMore: false, nextOffset: null });

  const sorted = sortItemsDesc([
    { key: "AAAA1111", dateModified: "2026-01-01T00:00:00Z" },
    { key: "BBBB2222", dateModified: "2026-01-02T00:00:00Z" },
    { key: "CCCC3333", dateModified: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(sorted.map((x) => x.key), ["CCCC3333", "BBBB2222", "AAAA1111"]);

  const fakeItem = {
    key: "ITEM0001",
    libraryID: 1,
    dateAdded: "2026-01-01T00:00:00Z",
    dateModified: "2026-01-02T00:00:00Z",
    version: 7,
    toJSON: () => ({
      itemType: "journalArticle",
      title: "Compact Title",
      creators: [{ lastName: "Doe" }],
      date: "2026",
      abstractNote: "Very long abstract that should be dropped in compact mode",
      extra: "Long extra block",
      DOI: "10.1000/test",
    }),
    isRegularItem: () => true,
    isFileAttachment: () => false,
    getBestAttachment: async () => ({ key: "ATT00001" }),
    getAttachments: () => [10],
    getNotes: () => [],
    getAnnotations: () => [20, 21],
  };

  const fullObj = await itemToJSON(fakeItem, { compact: false });
  assert.ok(fullObj.abstractNote, "full item keeps abstractNote");
  assert.ok(fullObj.extra, "full item keeps extra");
  const compactObj = await itemToJSON(fakeItem, { compact: true });
  assert.equal(compactObj.title, "Compact Title");
  assert.equal(compactObj.DOI, "10.1000/test");
  assert.equal(compactObj.bestAttachmentKey, "ATT00001");
  assert.equal(compactObj.abstractNote, undefined);
  assert.equal(compactObj.extra, undefined);
}

// 2. Mock HTTP + MCP stdio bridge tests: tools/list budget + query parameter forwarding
const recorded = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  recorded.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()) });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()) }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/zotero-agent-mcp`;

const child = spawn(process.execPath, [BRIDGE, "--token", "test-token", "--url", baseUrl], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 5000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });

  const listResp = await rpc("tools/list", {});
  const tools = listResp.result.tools;
  assert.equal(tools.length, 34, "must expose all 34 tools");

  const resultBytes = Buffer.byteLength(JSON.stringify(listResp.result), "utf8");
  const maxAllowed = Math.floor(BASELINE.toolsListBytes * 0.6);
  console.log({ resultBytes, baselineBytes: BASELINE.toolsListBytes, ratio: +(resultBytes / BASELINE.toolsListBytes).toFixed(3), maxAllowed });
  assert.ok(resultBytes <= maxAllowed, `tools/list bytes (${resultBytes}) exceeded 60% budget (${maxAllowed})`);

  for (const t of tools) {
    assert.ok(t.annotations, `missing annotations on ${t.name}`);
    assert.ok(t.description.length <= 90, `description too long on ${t.name}: ${t.description.length}`);
  }

  // Forward pagination, filtering, and compact params across all updated tools
  await rpc("tools/call", {
    name: "zotero_search",
    arguments: { tag: "ml", collection: "Parent / Sub", recursive: true, compact: true, limit: 200, offset: 400 },
  });
  await rpc("tools/call", {
    name: "zotero_get_collection_items",
    arguments: { key: "root", recursive: true, compact: true, limit: 500, offset: 500 },
  });
  await rpc("tools/call", {
    name: "zotero_recent",
    arguments: { limit: 100, offset: 200, unfiled: true, compact: true },
  });
  await rpc("tools/call", {
    name: "zotero_get_trash",
    arguments: { limit: 100, offset: 100, compact: true },
  });
  await rpc("tools/call", {
    name: "zotero_search_collections",
    arguments: { query: "ml", limit: 200, offset: 50 },
  });
  await rpc("tools/call", {
    name: "zotero_get_tags",
    arguments: { query: "read", limit: 1000, offset: 100 },
  });
  await rpc("tools/call", {
    name: "zotero_run_search",
    arguments: { key: "SRCH0001", compact: true, limit: 300, offset: 150 },
  });

  assert.equal(recorded.length, 7);
  assert.deepEqual(recorded[0], {
    method: "GET",
    path: "/zotero-agent-mcp/search",
    query: { tag: "ml", collection: "Parent / Sub", recursive: "true", compact: "true", limit: "200", offset: "400" },
  });
  assert.deepEqual(recorded[1], {
    method: "GET",
    path: "/zotero-agent-mcp/collection/root/items",
    query: { recursive: "true", compact: "true", limit: "500", offset: "500" },
  });
  assert.deepEqual(recorded[2], {
    method: "GET",
    path: "/zotero-agent-mcp/items/recent",
    query: { limit: "100", offset: "200", unfiled: "true", compact: "true" },
  });
  assert.deepEqual(recorded[3], {
    method: "GET",
    path: "/zotero-agent-mcp/items/trash",
    query: { limit: "100", offset: "100", compact: "true" },
  });
  assert.deepEqual(recorded[4], {
    method: "GET",
    path: "/zotero-agent-mcp/collections/search",
    query: { q: "ml", limit: "200", offset: "50" },
  });
  assert.deepEqual(recorded[5], {
    method: "GET",
    path: "/zotero-agent-mcp/tags",
    query: { q: "read", limit: "1000", offset: "100" },
  });
  assert.deepEqual(recorded[6], {
    method: "GET",
    path: "/zotero-agent-mcp/search/SRCH0001/items",
    query: { compact: "true", limit: "300", offset: "150" },
  });

  console.log("ALL MCP PAGINATION & COLLECTION TESTS PASSED");
} finally {
  child.kill();
  server.close();
}
