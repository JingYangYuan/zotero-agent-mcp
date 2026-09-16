#!/usr/bin/env node
/* E2E test for the zotero-agent MCP bridge.
 * Spawns bridge/bridge.mjs as a subprocess, speaks newline-delimited JSON-RPC,
 * and exercises every tool. Usage: node tools/test_bridge.mjs [bridgePath]
 * Env: ZOTERO_AGENT_URL, ZOTERO_AGENT_TOKEN (defaults to bridge defaults).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = process.argv[2] || path.join(root, "bridge", "bridge.mjs");

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
  ok("tools/list has 13 tools", names.length === 13, `got ${names.length}: ${names.join(",")}`);

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

  const unknown = await request("tools/call", { name: "no_such_tool", arguments: {} });
  ok("unknown tool -> isError content", !!unknown.result?.isError || !!unknown.error, JSON.stringify(unknown).slice(0, 150));

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
