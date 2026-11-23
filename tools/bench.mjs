#!/usr/bin/env node
/* Benchmark the MCP bridge: handshake latency, tools/list payload size, tool count.
 *
 *   node tools/bench.mjs [bridgePath] [--runs=N] [--json=path] [--baseline]
 *
 * Measures (per run): spawn → initialize response → tools/list response → ping.
 * Reports p50/p95 of the full handshake plus the exact bytes of the tools/list
 * result payload. Zotero does not need to be running for size/handshake numbers
 * (the bridge only talks HTTP on tools/call); `ping` is skipped when unreachable.
 *
 * `--baseline` writes tools/bench-baseline.json so later runs can assert
 * regressions (tools/test_bridge.mjs reads it when present).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const a of args) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags.set(m[1], m[2] ?? true);
  else positional.push(a);
}

const bridgePath = positional[0] || path.join(root, "bridge", "zotero-agent-mcp.mjs");
const runs = Math.max(1, parseInt(flags.get("runs") || "5", 10));
const baselinePath = path.join(root, "tools", "bench-baseline.json");

function pct(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function oneRun() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const out = { marks: {}, tools: 0, toolsListBytes: 0, initBytes: 0, ping: null, error: null };
    const seen = new Set();

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const timer = setTimeout(() => {
      out.error = "timeout";
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(out);
    }, 15000);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (msg.id === 1 && !seen.has("init")) {
          seen.add("init");
          out.marks.init = ms;
          out.initBytes = Buffer.byteLength(line, "utf8");
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2 && !seen.has("tools")) {
          seen.add("tools");
          out.marks.toolsList = ms;
          out.tools = msg.result?.tools?.length || 0;
          out.toolsListBytes = Buffer.byteLength(JSON.stringify(msg.result), "utf8");
          send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} });
        } else if (msg.id === 3 && !seen.has("ping")) {
          seen.add("ping");
          out.marks.ping = ms;
          clearTimeout(timer);
          try {
            child.kill("SIGKILL");
          } catch {}
          resolve(out);
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      out.error = String(e.message || e);
      resolve(out);
    });
    child.on("close", () => {
      if (!seen.has("ping")) {
        clearTimeout(timer);
        if (!out.error) out.error = "closed";
        resolve(out);
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1" } },
    });
  });
}

const results = [];
for (let i = 0; i < runs; i++) results.push(await oneRun());

const ok = results.filter((r) => r.marks.toolsList);
const handshakes = ok.map((r) => r.marks.toolsList);
const report = {
  bridge: bridgePath,
  node: process.version,
  runs,
  failures: results.filter((r) => !r.marks.toolsList).length,
  tools: ok[0]?.tools ?? 0,
  toolsListBytes: ok[0]?.toolsListBytes ?? 0,
  initBytes: ok[0]?.initBytes ?? 0,
  handshakeMs: {
    p50: Math.round(pct(handshakes, 50) * 100) / 100,
    p95: Math.round(pct(handshakes, 95) * 100) / 100,
    min: Math.round(Math.min(...handshakes) * 100) / 100,
  },
  time: new Date().toISOString(),
};

if (flags.get("baseline")) {
  writeFileSync(baselinePath, JSON.stringify(report, null, 2) + "\n");
  report.baselineWritten = baselinePath;
} else {
  try {
    const base = JSON.parse(readFileSync(baselinePath, "utf8"));
    if (base.toolsListBytes) {
      report.vsBaseline = {
        toolsListBytesRatio: Math.round((report.toolsListBytes / base.toolsListBytes) * 1000) / 1000,
        handshakeRatio: Math.round((report.handshakeMs.p50 / base.handshakeMs.p50) * 1000) / 1000,
      };
    }
  } catch {}
}

const jsonOut = flags.get("json");
if (typeof jsonOut === "string") writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
