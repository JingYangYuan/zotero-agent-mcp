#!/bin/bash
# Install the built xpi into the local Zotero profile (Zotero must be closed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$HOME/Library/Application Support/Zotero/Profiles/9x3rvg9b.default"
XPI="$ROOT/build/zotero-agent-mcp.xpi"

if pgrep -f "Zotero.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "Zotero is running — quitting it first..."
  osascript -e 'quit app "Zotero"' || true
  sleep 3
fi

cp "$XPI" "$PROFILE/extensions/zotero-agent-mcp@yjy.dev.xpi"
echo "Installed to $PROFILE/extensions/zotero-agent-mcp@yjy.dev.xpi"
