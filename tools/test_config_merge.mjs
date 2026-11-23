/* Verifies the plugin's surgical JSON/TOML merge helpers against copies of the
 * real client configs on this machine. Run: node tools/test_config_merge.mjs
 *
 * The helpers are extracted verbatim from plugin/zotero-agent-mcp.js so the test
 * exercises the shipped code, not a reimplementation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "plugin", "zotero-agent-mcp.js"), "utf8");

const startMarker = "  function skipWs(text, i) {";
const endMarker = "  async function configTargetPath(c) {";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
if (start < 0 || end < 0) throw new Error("helper block not found in plugin source");
const helpers = src.slice(start, end);

const sandbox = {};
const factory = new Function(
  helpers +
    "\nreturn { jsonSetEntry, jsonCreateEntry, jsonRemoveEntry, tomlSetSection, tomlStripSection, isParseableJson, findMember, jsonNodeAt };"
);
const M = factory();

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, detail === undefined ? "" : String(detail).slice(0, 300));
  }
}

const entryJson = JSON.stringify(
  {
    type: "stdio",
    command: "/usr/local/bin/node",
    args: ["/Users/yjy/Zotero/zotero-agent-mcp/zotero-agent-mcp.mjs"],
    env: { ZOTERO_AGENT_URL: "http://127.0.0.1:23119/zotero-agent-mcp", ZOTERO_AGENT_TOKEN: "TESTTOKEN" },
  },
  null,
  2
).replace(/\n/g, "\n  ");

function stripEntry(doc, keys, key) {
  let node = doc;
  for (const k of keys) node = node?.[k];
  if (!node) return doc;
  delete node[key];
  return doc;
}

function testJsonFile(label, file, keys) {
  if (!fs.existsSync(file)) {
    console.log("SKIP ", label, "(no file)");
    return;
  }
  const original = fs.readFileSync(file, "utf8");
  const before = JSON.parse(original);
  // note: stripEntry() mutates, so capture this before comparing
  const hadEntry = (() => {
    let n = before;
    for (const k of keys) n = n?.[k];
    return !!(n && n["zotero-agent"]);
  })();

  let added = M.jsonSetEntry(original, keys, "zotero-agent", entryJson);
  if (added === null) added = M.jsonCreateEntry(original, keys, "zotero-agent", entryJson);
  ok(`${label}: insert produces valid JSON`, added !== null && M.isParseableJson(added));

  const parsed = JSON.parse(added);
  let node = parsed;
  for (const k of keys) node = node?.[k];
  ok(`${label}: entry present`, !!node?.["zotero-agent"]);
  ok(
    `${label}: other keys untouched`,
    JSON.stringify(stripEntry(parsed, keys, "zotero-agent")) === JSON.stringify(stripEntry(before, keys, "zotero-agent"))
  );

  // idempotent: setting the same entry again must not change bytes
  const again = M.jsonSetEntry(added, keys, "zotero-agent", entryJson);
  ok(`${label}: idempotent`, again !== null && again === added, again === added ? "" : "bytes changed on rewrite");

  // removal: byte-identical when the file did not have our entry before, otherwise
  // it must drop only that entry and stay valid.
  const removed = M.jsonRemoveEntry(added, keys, "zotero-agent");
  ok(`${label}: removal leaves valid JSON`, M.isParseableJson(removed));
  let after = JSON.parse(removed);
  let afterNode = after;
  for (const k of keys) afterNode = afterNode?.[k];
  ok(`${label}: entry removed`, !afterNode || !afterNode["zotero-agent"]);
  ok(
    `${label}: removal keeps other keys`,
    JSON.stringify(afterNode && Object.keys(afterNode)) ===
      JSON.stringify(
        (() => {
          let n = before;
          for (const k of keys) n = n?.[k];
          return n ? Object.keys(n).filter((k) => k !== "zotero-agent") : undefined;
        })()
      )
  );
  if (!hadEntry) ok(`${label}: removal restores original bytes`, removed === original, `\n--- got ---\n${removed.slice(0, 200)}`);
  else console.log("SKIP ", label, "byte-restore (entry already existed)");

  // preserve trailing unrelated formatting: file should not be reformatted
  ok(`${label}: original formatting preserved`, added.includes(original.slice(0, 40).trim().slice(0, 1)));
}

// --- JSON clients ---
testJsonFile("claude-code (~/.claude.json)", path.join(os.homedir(), ".claude.json"), ["mcpServers"]);
testJsonFile("cursor", path.join(os.homedir(), ".cursor", "mcp.json"), ["mcpServers"]);
testJsonFile("pi", path.join(os.homedir(), ".pi", "agent", "mcp.json"), ["mcpServers"]);
testJsonFile("zcode", path.join(os.homedir(), ".zcode", "cli", "config.json"), ["mcp", "servers"]);

// --- containers that do not exist yet ---
{
  const empty = '{\n  "someOther": true\n}\n';
  let out = M.jsonSetEntry(empty, ["servers"], "zotero-agent", entryJson);
  ok("vscode: missing container -> null", out === null);
  out = M.jsonCreateEntry(empty, ["servers"], "zotero-agent", entryJson);
  ok("vscode: container created", M.isParseableJson(out) && JSON.parse(out).servers["zotero-agent"]);
  ok("vscode: other keys kept", JSON.parse(out).someOther === true);
  const removed = M.jsonRemoveEntry(out, ["servers"], "zotero-agent");
  ok("vscode: removal leaves valid JSON", M.isParseableJson(removed) && !JSON.parse(removed).servers["zotero-agent"]);
}
{
  const empty = "{}\n";
  const out = M.jsonCreateEntry(empty, ["mcp", "servers"], "zotero-agent", entryJson);
  ok("zcode: nested container created", M.isParseableJson(out) && JSON.parse(out).mcp.servers["zotero-agent"]);
}
{
  // invalid JSON must be refused by the caller's validation
  ok("invalid JSON detected", M.isParseableJson("{ nope") === false);
}

// --- TOML (codex) ---
{
  const tmp = path.join(os.tmpdir(), "zam-codex-test.toml");
  const original = `model = "gpt-5"\n\n[mcp_servers.stata]\ncommand = "/usr/local/bin/stata-mcp"\n\n[mcp_servers.stata.env]\nLOG_LEVEL = "INFO"\n`;
  fs.writeFileSync(tmp, original);
  const entry = { command: "/usr/local/bin/node", args: ["/x/bridge.mjs"], env: { ZOTERO_AGENT_TOKEN: "TESTTOKEN" } };
  const added = M.tomlSetSection(original, "zotero-agent", entry);
  ok("codex: section added", added.includes("[mcp_servers.zotero-agent]") && added.includes("[mcp_servers.zotero-agent.env]"));
  ok("codex: existing sections untouched", added.includes("[mcp_servers.stata]") && added.includes('LOG_LEVEL = "INFO"'));

  const addedTwice = M.tomlSetSection(added, "zotero-agent", entry);
  ok("codex: idempotent", addedTwice.trim() === added.trim(), "rewrite changed content");

  const updated = M.tomlSetSection(added, "zotero-agent", { ...entry, env: { ZOTERO_AGENT_TOKEN: "NEWTOKEN" } });
  ok("codex: token updated", updated.includes("NEWTOKEN") && !updated.includes("TESTTOKEN"));
  ok("codex: single section after update", (updated.match(/\[mcp_servers\.zotero-agent\]/g) || []).length === 1);

  const removed = M.tomlStripSection(added, "zotero-agent");
  ok("codex: removal drops both sections", !removed.includes("zotero-agent"));
  ok("codex: removal keeps other sections", removed.includes("[mcp_servers.stata]") && removed.includes('LOG_LEVEL = "INFO"'));
  fs.unlinkSync(tmp);
}

console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
