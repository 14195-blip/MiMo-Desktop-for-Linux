#!/usr/bin/env bash
# mimo-bootstrap.sh — install Deno (if missing) and any missing system tools,
# then run mimo-linux.ts with whatever arguments you pass through.
#
# Usage:
#   ./mimo-bootstrap.sh [SETUP.exe] [--target-arch x64|arm64] [--deb] [...]
#
# All arguments are forwarded as-is to `deno run -A mimo-linux.ts`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v deno >/dev/null 2>&1; then
  echo "deno not found — installing..."
  curl -fsSL https://deno.land/install.sh | sh
  export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
  export PATH="$DENO_INSTALL/bin:$PATH"
fi

MISSING=()
for tool in 7z curl npm unzip tar dpkg-deb; do
  command -v "$tool" >/dev/null 2>&1 || MISSING+=("$tool")
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "installing missing tools via apt: ${MISSING[*]}"
    PKGS=()
    for m in "${MISSING[@]}"; do
      case "$m" in
        7z) PKGS+=("p7zip-full") ;;
        dpkg-deb) PKGS+=("dpkg-dev") ;;
        *) PKGS+=("$m") ;;
      esac
    done
    SUDO=""
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    fi
    $SUDO apt-get update -y
    $SUDO apt-get install -y "${PKGS[@]}"
  else
    echo "missing tools (install manually, no apt-get available): ${MISSING[*]}" >&2
    exit 1
  fi
fi

exec deno run -A "$SCRIPT_DIR/mimo-linux.ts" "$@"
