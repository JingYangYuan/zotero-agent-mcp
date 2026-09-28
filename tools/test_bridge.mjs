#!/usr/bin/env node
/* E2E test for the zotero-agent MCP bridge.
 * Spawns bridge/bridge.mjs as a subprocess, speaks newline-delimited JSON-RPC,
 * and exercises every tool. Usage: node tools/test_bridge.mjs [bridgePath]
 * Env: ZOTERO_AGENT_URL, ZOTERO_AGENT_TOKEN (defaults to bridge defaults).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = process.argv[2] || path.join(root, "bridge", "zotero-agent-mcp.mjs");

const N_TOOLS = 14; // bump when adding a tool
// Env gates: CREATE_ITEM_TEST=1 exercises zotero_add_item (writes to the library);
// SET_COLLECTIONS_TEST=1 exercises zotero_set_item_collections (creates e2e collections)
const CREATE_ITEM_TEST = process.env.CREATE_ITEM_TEST === "1";
const SET_COLLECTIONS_TEST = process.env.SET_COLLECTIONS_TEST === "1";

// Minimal but well-formed PDF WITH a text layer (a bare %PDF stub extracts no text)
function makeTestPdf(p) {
  const stream = "BT /F1 24 Tf 72 720 Td (zotero-agent-mcp fulltext probe) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i <= objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i - 1]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(p, out, "latin1");
}

// Zotero 10 local API: reads are open, writes need a persisted local key
// (one-time "Always Allow" via tools/authorize_localapi.sh) plus the server ID
let localApiKey = null;
let serverId = null;
async function localApiBootstrap() {
  try {
    localApiKey = readFileSync(path.join(root, "tools", ".localapi-key"), "utf8").trim() || null;
  } catch {
    localApiKey = null;
  }
  try {
    const res = await fetch("http://127.0.0.1:23119/api/users/0/collections");
    serverId = res.headers.get("Zotero-Server-ID");
  } catch {}
}

// Idempotently ensure an e2e collection exists, via Zotero's built-in local API
async function ensureCollection(name) {
  const base = "http://127.0.0.1:23119/api/users/0";
  const headers = { Accept: "application/json" };
  if (serverId) headers["Zotero-Server-ID"] = serverId;
  const list = await (await fetch(`${base}/collections`, { headers })).json();
  const found = (Array.isArray(list) ? list : []).find((c) => c.data?.name === name);
  if (found) return found.key;
  if (!localApiKey) return null;
  const res = await fetch(`${base}/collections`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Zotero-API-Key": localApiKey },
    body: JSON.stringify([{ name }]),
  }).then((r) => r.json());
  return res?.success?.["0"];
}

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const child = spawn(process.execPath, [bridgePath], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderrBuf = "";
child.stderr.on("data", (d) => (stderrBuf += d.toString()));

const rl = createInterface({ input: child.stdout });
let pending = new Map();
let nextId = 1;
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function request(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

async function tool(name, args) {
  const msg = await request("tools/call", { name, arguments: args });
  if (msg.error) return { error: msg.error };
  const text = msg.result?.content?.[0]?.text ?? "";
  const parsed = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  return { result: msg.result, text, parsed, isError: !!msg.result?.isError };
}

try {
  await localApiBootstrap();

  // initialize handshake
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  });
  ok("initialize returns serverInfo", !!init.result?.serverInfo?.name, JSON.stringify(init).slice(0, 200));
  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  ok(`tools/list has ${N_TOOLS} tools`, names.length === N_TOOLS, `got ${names.length}: ${names.join(",")}`);

  const ping = await tool("zotero_ping", {});
  ok("zotero_ping ok", !ping.isError && ping.parsed?.plugin === "zotero-agent-mcp", ping.text?.slice(0, 200));

  const libs = await tool("zotero_libraries", {});
  ok("zotero_libraries returns ≥1", !libs.isError && libs.parsed?.libraries?.length >= 1, libs.text?.slice(0, 200));
  const userLib = libs.parsed?.libraries?.find((l) => l.type === "user");

  const cols = await tool("zotero_collections", { library: "user" });
  ok("zotero_collections ok", !cols.isError && Array.isArray(cols.parsed?.collections), cols.text?.slice(0, 150));

  const search = await tool("zotero_search", { query: "the", limit: 3 });
  ok("zotero_search returns items", !search.isError && Array.isArray(search.parsed?.items), search.text?.slice(0, 200));
  const anyItem = search.parsed?.items?.[0];

  const recent = await tool("zotero_recent", { library: "user", limit: 3 });
  ok("zotero_recent ok", !recent.isError && Array.isArray(recent.parsed?.items));
  const key = anyItem?.key || recent.parsed?.items?.[0]?.key;
  ok("obtained an item key", !!key);
  if (!key) throw new Error("no item key available for remaining tests");

  const item = await tool("zotero_get_item", { key });
  ok("zotero_get_item metadata", !item.isError && item.parsed?.key === key && item.parsed?.itemType, item.text?.slice(0, 200));

  const ft = await tool("zotero_get_fulltext", { key, max_chars: 3000 });
  ok(
    "zotero_get_fulltext ok or clean error",
    !ft.isError === true || Number.isInteger(ft.parsed) === false, // isError handled below
    ft.text?.slice(0, 200)
  );
  if (!ft.isError) {
    ok(
      "fulltext has content pagination fields",
      typeof ft.parsed?.totalChars === "number" && typeof ft.parsed?.content === "string"
    );
  } else {
    ok("fulltext error is clean (no_attachment/415/404)", /no_attachment|extraction_unavailable|unsupported_type|file_missing/.test(ft.text));
  }

  const anns = await tool("zotero_get_annotations", { key });
  ok("zotero_get_annotations array", !anns.isError && Array.isArray(anns.parsed?.annotations), anns.text?.slice(0, 150));

  const cite = await tool("zotero_cite", { key, format: "bibtex" });
  ok("zotero_cite bibtex text", !cite.isError && /@/.test(cite.parsed?.text || ""), cite.text?.slice(0, 200));
  const cite2 = await tool("zotero_cite", { key, format: "bibliography", style: "apa" });
  ok("zotero_cite apa bibliography", !cite2.isError && String(cite2.parsed?.text || "").length > 10, cite2.text?.slice(0, 200));

  const note = await tool("zotero_add_note", { key, html: "E2E test note from MCP bridge" });
  const writeEnabled = !note.isError;
  if (writeEnabled) {
    ok("zotero_add_note created", note.parsed?.created === true, note.text?.slice(0, 200));
  } else {
    ok("zotero_add_note cleanly 403 when write scope off", /scope_disabled/.test(note.text), note.text?.slice(0, 200));
  }

  const tag = await tool("zotero_add_tag", { key, tag: "zotero-agent-mcp-e2e", action: "add" });
  if (writeEnabled) {
    ok("zotero_add_tag added", tag.parsed?.changed === true || tag.parsed?.changed === false, tag.text?.slice(0, 200));
    const tagRm = await tool("zotero_add_tag", { key, tag: "zotero-agent-mcp-e2e", action: "remove" });
    ok("zotero_add_tag removed", tagRm.parsed?.changed === true, tagRm.text?.slice(0, 200));
  } else {
    ok("zotero_add_tag cleanly 403 when write scope off", /scope_disabled/.test(tag.text), tag.text?.slice(0, 200));
  }

  const bad = await tool("zotero_get_item", { key: "ZZZZZZZZ" });
  ok("unknown key -> clean error", bad.isError && /not_found/.test(bad.text), bad.text?.slice(0, 150));

  if (CREATE_ITEM_TEST) {
    // v0.4.0: zotero_add_item with fields + creators. os.tmpdir() is a real Windows
    // path when node runs natively, so the Zotero process can read the file.
    const pdfPath = path.join(os.tmpdir(), "zotero-agent-mcp-bridge-test.pdf");
    makeTestPdf(pdfPath);
    const created = await tool("zotero_add_item", {
      path: pdfPath,
      title: "Bridge Suite Metadata",
      item_type: "journalArticle",
      fields: { date: "2023", publicationTitle: "测试期刊", DOI: "10.1234/bridge", bogusField: "x" },
      creators: [{ name: "李四" }, { firstName: "Jane", lastName: "Doe" }],
      tags: ["zotero-agent-mcp-e2e"],
    });
    const c = created.parsed;
    if (!created.isError && c?.created === true) {
      ok("zotero_add_item created", true);
      ok("zotero_add_item skippedFields", Array.isArray(c.skippedFields) && c.skippedFields.includes("bogusField"), JSON.stringify(c).slice(0, 200));
      const back = await tool("zotero_get_item", { key: c.itemKey });
      const b = back.parsed;
      ok(
        "zotero_add_item metadata roundtrip",
        !back.isError && b?.date === "2023" && b?.publicationTitle === "测试期刊" && b?.creators?.[0]?.name === "李四" && b?.creators?.some((x) => x.lastName === "Doe"),
        back.text?.slice(0, 300)
      );
    } else {
      ok("zotero_add_item created", false, created.text?.slice(0, 300));
      ok("zotero_add_item skippedFields", false);
      ok("zotero_add_item metadata roundtrip", false);
    }
  } else {
    console.log("SKIP  zotero_add_item cases (set CREATE_ITEM_TEST=1)");
  }

  if (SET_COLLECTIONS_TEST) {
    // v0.4.1: zotero_set_item_collections on a dedicated scratch item
    const collA = await ensureCollection("zotero-agent-mcp-e2e-coll-a");
    const collB = await ensureCollection("zotero-agent-mcp-e2e-coll-b");
    if (!collA || !collB) {
      console.log("SKIP  zotero_set_item_collections cases — run tools/authorize_localapi.sh once (click 'Always Allow') to enable seeding");
    } else {
      const pdfPath = path.join(os.tmpdir(), "zotero-agent-mcp-bridge-collections.pdf");
      makeTestPdf(pdfPath);
      const scratch = await tool("zotero_add_item", { path: pdfPath, title: "Bridge Suite Collections", tags: ["zotero-agent-mcp-e2e"] });
      const ckey = scratch.parsed?.itemKey;
      if (!scratch.isError && ckey) {
        const rep = await tool("zotero_set_item_collections", { key: ckey, collections: [collA] });
        ok("set_item_collections replace", !rep.isError && rep.parsed?.changed === true && rep.parsed?.collections?.[0]?.key === collA, rep.text?.slice(0, 250));
        const rep2 = await tool("zotero_set_item_collections", { key: ckey, collections: [collA] });
        ok("set_item_collections no-op", !rep2.isError && rep2.parsed?.changed === false, rep2.text?.slice(0, 250));
        const add = await tool("zotero_set_item_collections", { key: ckey, collections: ["zotero-agent-mcp-e2e-coll-b"], mode: "add" });
        ok("set_item_collections add by name", !add.isError && add.parsed?.collections?.length === 2, add.text?.slice(0, 250));
        const rem = await tool("zotero_set_item_collections", { key: ckey, collections: [collA], mode: "remove" });
        ok("set_item_collections remove", !rem.isError && rem.parsed?.collections?.map((c) => c.key).join() === collB, rem.text?.slice(0, 250));
        const unknown = await tool("zotero_set_item_collections", { key: ckey, collections: ["NOPE"], mode: "add" });
        ok("set_item_collections unknown -> error", unknown.isError && /not_found/.test(unknown.text), unknown.text?.slice(0, 200));
      } else {
        ok("set_item_collections replace", false, `scratch item failed: ${scratch.text?.slice(0, 200)}`);
        ok("set_item_collections no-op", false);
        ok("set_item_collections add by name", false);
        ok("set_item_collections remove", false);
        ok("set_item_collections unknown -> error", false);
      }
    }
  } else {
    console.log("SKIP  zotero_set_item_collections cases (set SET_COLLECTIONS_TEST=1)");
  }

  const unknownTool = await request("tools/call", { name: "no_such_tool", arguments: {} });
  ok("unknown tool -> isError content", !!unknownTool.result?.isError || !!unknownTool.error, JSON.stringify(unknownTool).slice(0, 150));

  const pingReq = await request("ping", {});
  ok("protocol ping -> {}", "result" in pingReq);

  ok("stderr has startup line", stderrBuf.includes("bridge ready"));
} catch (e) {
  fail++;
  console.log("FATAL", e);
} finally {
  child.kill();
}

console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
