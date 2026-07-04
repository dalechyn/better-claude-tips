#!/usr/bin/env bash
# One-shot installer for Clados — a Claude Code hook that surfaces a relevant
# Hacker News article in the spinner tip while Claude works.
#
# Run from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/dalechyn/better-claude-tips/main/install.sh | bash
#
# Optionally seed your OpenRouter key at install time:
#   curl -fsSL https://raw.githubusercontent.com/dalechyn/better-claude-tips/main/install.sh | OPENROUTER_API_KEY=sk-or-... bash
set -euo pipefail

REPO_URL="https://github.com/dalechyn/better-claude-tips.git"
INSTALL_DIR="$HOME/.clados"

# Source files: use the local checkout if this script is run from inside the
# repo; otherwise (piped from curl) clone a shallow copy to a temp dir.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
CLEANUP=""
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/src/worker.ts" ]; then
  SRC_DIR="$SELF_DIR"
else
  echo "→ Fetching Clados"
  SRC_DIR="$(mktemp -d)"
  CLEANUP="$SRC_DIR"
  git clone --depth 1 "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1
fi
trap '[ -n "$CLEANUP" ] && rm -rf "$CLEANUP"' EXIT

source "$SRC_DIR/scripts/find-node.sh"
resolve_node

echo "→ Installing Clados to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/src" "$INSTALL_DIR/scripts"
cp "$SRC_DIR/src/hook.ts"                        "$INSTALL_DIR/src/"
cp "$SRC_DIR/src/worker.ts"                       "$INSTALL_DIR/src/"
cp "$SRC_DIR/package.json"                         "$INSTALL_DIR/"
cp "$SRC_DIR/tsconfig.json"                        "$INSTALL_DIR/"
cp "$SRC_DIR/scripts/update-claude-settings.py"    "$INSTALL_DIR/scripts/"

echo "→ Installing dependencies"
PATH="$NODE_BIN_DIR:$PATH" ${ARCH_PREFIX}npm install --prefix "$INSTALL_DIR" --silent

# Seed config.json on first install; never clobber an existing one.
CONFIG="$INSTALL_DIR/config.json"
NEED_KEY=0
if [ ! -f "$CONFIG" ]; then
  KEY="${OPENROUTER_API_KEY:-}"
  ( umask 177; cat > "$CONFIG" <<JSON
{
  "openrouterKey": "$KEY",
  "model": "nvidia/nemotron-3-nano-30b-a3b:free",
  "fallbackModel": "openai/gpt-oss-20b:free",
  "debug": false
}
JSON
  )
  [ -z "$KEY" ] && NEED_KEY=1
fi

TSX="$INSTALL_DIR/node_modules/.bin/tsx"
HOOK_SCRIPT="$INSTALL_DIR/src/hook.ts"
COMMAND="${ARCH_PREFIX}env PATH=\"$NODE_BIN_DIR:\$PATH\" $TSX $HOOK_SCRIPT"

echo "→ Registering Claude Code hook"
python3 "$INSTALL_DIR/scripts/update-claude-settings.py" "$COMMAND"

echo "✓ Clados installed. Restart Claude Code to activate."
if [ "$NEED_KEY" = "1" ]; then
  echo
  echo "⚠ One more step — add a (free) OpenRouter API key:"
  echo "    1. Get one at https://openrouter.ai/keys"
  echo "    2. Put it in $CONFIG under \"openrouterKey\""
fi
