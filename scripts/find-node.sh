#!/usr/bin/env bash
# Outputs: NODE_BIN_DIR and ARCH_PREFIX (sourced by install scripts)

find_node_bin_dir() {
  # 1. Node already in PATH and working
  if command -v node &>/dev/null && node --version &>/dev/null 2>&1; then
    dirname "$(command -v node)"
    return 0
  fi

  # 2. NVM — pick latest installed version
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -d "$nvm_dir/versions/node" ]; then
    local latest
    latest=$(ls -v "$nvm_dir/versions/node" 2>/dev/null | tail -1)
    if [ -n "$latest" ] && [ -x "$nvm_dir/versions/node/$latest/bin/node" ]; then
      echo "$nvm_dir/versions/node/$latest/bin"
      return 0
    fi
  fi

  # 3. Homebrew (Apple Silicon and Intel)
  for dir in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$dir/node" ]; then
      echo "$dir"
      return 0
    fi
  done

  return 1
}

needs_arch_arm64() {
  local node="$1/node"
  # True when the node binary is arm64 but the current shell is x86_64 (Rosetta)
  if file "$node" 2>/dev/null | grep -q arm64 && [ "$(uname -m)" = "x86_64" ]; then
    return 0
  fi
  return 1
}

resolve_node() {
  NODE_BIN_DIR=$(find_node_bin_dir) || {
    echo "Error: Node.js not found. Install Node via nvm or homebrew." >&2
    exit 1
  }

  ARCH_PREFIX=""
  if needs_arch_arm64 "$NODE_BIN_DIR"; then
    ARCH_PREFIX="arch -arm64 "
  fi
}
