#!/bin/bash
# One-time setup: expose the plugin-released agent skill to ZCode.
#
# The plugin releases skill/SKILL.md to <Zotero data dir>/zotero-agent-mcp/skill/
# on every startup. This script junctions (or copies) it into ~/.zcode/skills/
# so the skill is discovered by the agent. Re-run any time — idempotent; updating
# the plugin automatically updates the skill through the junction.
#
# Usage: tools/install-skill.sh [zotero-data-dir]
set -euo pipefail

DEST_DIR="${1:-}"
if [ -z "$DEST_DIR" ]; then
  # Auto-detect: look for the released skill next to the bridge in common data dirs
  for c in \
    "$(cygpath -u "$USERPROFILE" 2>/dev/null)/Zotero" \
    "E:/Zotero/Storage" \
    "D:/Zotero" \
    "$(cygpath -u "$USERPROFILE" 2>/dev/null)/Documents/Zotero"; do
    if [ -f "$c/zotero-agent-mcp/skill/SKILL.md" ]; then
      DEST_DIR="$c"
      break
    fi
  done
fi
if [ -z "$DEST_DIR" ] || [ ! -f "$DEST_DIR/zotero-agent-mcp/skill/SKILL.md" ]; then
  echo "ERROR: released skill not found."
  echo "Make sure Zotero is running with the plugin installed (it releases the skill on"
  echo "startup), then re-run: tools/install-skill.sh <zotero-data-dir>"
  exit 1
fi

SRC="$DEST_DIR/zotero-agent-mcp/skill"
TARGET="$(cygpath -u "$USERPROFILE" 2>/dev/null || echo "$HOME")/.zcode/skills/zotero-agent"
mkdir -p "$(dirname "$TARGET")"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then
    # real directory (maybe from an older copy-based install) — refresh it
    rm -rf "$TARGET"
  else
    rm "$TARGET"
  fi
fi

# Junction via cmd (works without admin on NTFS); fall back to cp
SRC_WIN=$(cygpath -w "$SRC")
TARGET_WIN=$(cygpath -w "$TARGET")
if cmd //c mklink //J "$TARGET_WIN" "$SRC_WIN" >/dev/null 2>&1; then
  echo "OK: junction $TARGET -> $SRC_WIN"
else
  mkdir -p "$TARGET"
  cp "$SRC/SKILL.md" "$TARGET/SKILL.md"
  echo "OK: copied $SRC/SKILL.md -> $TARGET/SKILL.md (junction unavailable)"
fi
echo "Skill 'zotero-agent' installed. Restart your agent session to pick it up."
