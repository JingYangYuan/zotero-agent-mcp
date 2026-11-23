#!/bin/bash
# Install the zotero-agent routing skill into local agent skill directories.
#
# The supported path is Zotero → Settings → Zotero-Agent-MCP → 一键接入 →「安装路由 skill」
# (it also writes the manifest used by the in-app undo). This script is the CLI
# equivalent for headless setups; it uses the same target list and manifest.
#
# Usage:
#   tools/install-skill.sh            # install into every detected agent dir
#   tools/install-skill.sh --undo     # remove what this manifest installed
#
# Env: ZOTERO_DATA_DIR overrides auto-detection of the Zotero data directory.
set -euo pipefail

DATA_DIR="${ZOTERO_DATA_DIR:-}"
if [ -z "$DATA_DIR" ]; then
  for c in "$HOME/Zotero" "$HOME/Documents/Zotero" "${USERPROFILE:-}" ; do
    if [ -n "$c" ] && [ -f "$c/zotero-agent-mcp/skill/SKILL.md" ]; then
      DATA_DIR="$c"
      break
    fi
  done
fi
if [ -z "$DATA_DIR" ]; then
  DATA_DIR="$HOME/Zotero"
fi

SRC_DIR="$DATA_DIR/zotero-agent-mcp/skill"
MANIFEST="$DATA_DIR/zotero-agent-mcp/skills-installed.json"

if [ ! -f "$SRC_DIR/SKILL.md" ]; then
  echo "ERROR: released skill not found at $SRC_DIR/SKILL.md"
  echo "Start Zotero once with the plugin enabled (it releases the skill on startup)."
  exit 1
fi

undo() {
  if [ ! -f "$MANIFEST" ]; then
    echo "Nothing to undo (no manifest at $MANIFEST)."
    exit 0
  fi
  # Remove only directories this tool recorded, then drop the manifest.
  node -e '
const fs = require("fs");
const [manifestPath] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const dir of Object.keys(manifest.entries || {})) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) fs.unlinkSync(dir);
    else fs.rmSync(dir, { recursive: true, force: true });
    console.log("removed", dir);
  } catch (e) {
    console.log("skip", dir, "-", e.code || e.message);
  }
}
manifest.entries = {};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
' "$MANIFEST"
  echo "Undo complete."
}

if [ "${1:-}" = "--undo" ]; then
  undo
  exit 0
fi

CLIENTS_SRC="$DATA_DIR/zotero-agent-mcp/clients.json"
TARGETS=""
if [ -f "$CLIENTS_SRC" ]; then
  TARGETS=$(node -e '
const fs = require("fs");
const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const c of reg.clients || []) if (c.skillDir) console.log(c.skillDir);
' "$CLIENTS_SRC")
else
  TARGETS=$(cat <<'EOF'
~/.claude/skills/zotero-agent
~/.codex/skills/zotero-agent
~/.cursor/skills/zotero-agent
~/.gemini/skills/zotero-agent
~/.zcode/skills/zotero-agent
~/.pi/agent/skills/zotero-agent
EOF
)
fi

node -e '
const fs = require("fs");
const os = require("os");
const path = require("path");
const [srcDir, manifestPath, targetsRaw] = process.argv.slice(1);
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const manifest = (() => {
  try { return JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return { version: 1, entries: {} }; }
})();
manifest.entries = manifest.entries || {};
let installed = 0, skipped = 0;
for (const raw of targetsRaw.split("\n").map((s) => s.trim()).filter(Boolean)) {
  const dir = expand(raw);
  const parent = path.dirname(dir);
  if (!fs.existsSync(parent)) { console.log("skip (no client dir):", dir); skipped++; continue; }
  try {
    if (fs.existsSync(dir) || fs.lstatSync(dir, { throwIfNoEntry: false })) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  let mode = "copy";
  try {
    fs.symlinkSync(srcDir, dir, "dir");
    mode = "symlink";
  } catch {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(srcDir, "SKILL.md"), path.join(dir, "SKILL.md"));
  }
  manifest.entries[dir] = { mode, source: srcDir, at: new Date().toISOString() };
  console.log(`installed (${mode}):`, dir);
  installed++;
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\n${installed} installed, ${skipped} skipped. Restart the agent session to pick up the skill.`);
console.log("Undo with: tools/install-skill.sh --undo");
' "$SRC_DIR" "$MANIFEST" "$TARGETS"
