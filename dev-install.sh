#!/usr/bin/env bash
# Development install: registers the hook pointing to the current working tree.
# Run this once after cloning; no copy is made — edits to src/ take effect immediately.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/scripts/find-node.sh"
resolve_node

# Install dependencies if missing
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "→ Installing dependencies"
  PATH="$NODE_BIN_DIR:$PATH" ${ARCH_PREFIX}npm install --prefix "$SCRIPT_DIR" --silent
fi

TSX="$SCRIPT_DIR/node_modules/.bin/tsx"
HOOK_SCRIPT="$SCRIPT_DIR/src/hook.ts"

COMMAND="${ARCH_PREFIX}env PATH=\"$NODE_BIN_DIR:\$PATH\" $TSX $HOOK_SCRIPT"

echo "→ Registering Claude Code hook (dev mode, pointing to $SCRIPT_DIR)"
python3 "$SCRIPT_DIR/scripts/update-claude-settings.py" "$COMMAND"

echo "✓ Clados dev-installed. Restart Claude Code to activate."
echo "  Hook command: $COMMAND"
