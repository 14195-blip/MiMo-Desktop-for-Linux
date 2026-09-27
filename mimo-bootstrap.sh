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
for tool in curl npm unzip tar dpkg-deb; do
  command -v "$tool" >/dev/null 2>&1 || MISSING+=("$tool")
done

# 7z is checked separately: on Ubuntu 24.04+ ("noble"), p7zip-full is a
# transitional dummy package that no longer installs a `7z` binary — it
# just pulls in `7zip`, whose binary is `7zz`. Accept either.
NEED_7Z=0
if ! command -v 7z >/dev/null 2>&1 && ! command -v 7zz >/dev/null 2>&1; then
  NEED_7Z=1
  MISSING+=("7z")
fi

if [ "${#MISSING[@]}" -gt 0 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "installing missing tools via apt: ${MISSING[*]}"
    PKGS=()
    for m in "${MISSING[@]}"; do
      case "$m" in
        7z) PKGS+=("p7zip-full" "7zip") ;;
        dpkg-deb) PKGS+=("dpkg-dev") ;;
        *) PKGS+=("$m") ;;
      esac
    done
    SUDO=""
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    fi
    $SUDO apt-get update -y
    # `7zip` may not exist on older distros; don't let that abort the whole
    # install of the other (real) missing packages.
    $SUDO apt-get install -y "${PKGS[@]}" || $SUDO apt-get install -y \
      "$(printf '%s\n' "${PKGS[@]}" | grep -v '^7zip$')"
  elif command -v pkg >/dev/null 2>&1; then
    # Termux
    echo "installing missing tools via pkg: ${MISSING[*]}"
    PKGS=()
    for m in "${MISSING[@]}"; do
      case "$m" in
        7z) PKGS+=("p7zip") ;;
        dpkg-deb) continue ;; # not applicable on Termux; --deb won't work there
        *) PKGS+=("$m") ;;
      esac
    done
    pkg install -y "${PKGS[@]}"
  else
    echo "missing tools (install manually, no apt-get/pkg available): ${MISSING[*]}" >&2
    exit 1
  fi
fi

# Make sure a `7z` command resolves even if only `7zz` got installed.
if ! command -v 7z >/dev/null 2>&1 && command -v 7zz >/dev/null 2>&1; then
  SUDO=""
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi
  $SUDO ln -sf "$(command -v 7zz)" /usr/local/bin/7z 2>/dev/null || true
fi

if ! command -v 7z >/dev/null 2>&1 && ! command -v 7zz >/dev/null 2>&1; then
  echo "error: could not find or install a working 7-Zip binary (7z/7zz)" >&2
  exit 1
fi

exec deno run -A "$SCRIPT_DIR/mimo-linux.ts" "$@"
