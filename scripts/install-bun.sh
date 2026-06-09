#!/usr/bin/env zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64) BUN_ARCH="aarch64" ;;
  x86_64) BUN_ARCH="x64" ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-${BUN_ARCH}.zip"
WORK_DIR="$PROJECT_DIR/vendor/bun-download"
INSTALL_DIR="$PROJECT_DIR/vendor/bun"

rm -rf "$WORK_DIR" "$INSTALL_DIR"
mkdir -p "$WORK_DIR" "$INSTALL_DIR"

curl -fsSL "$URL" -o "$WORK_DIR/bun.zip"
unzip -q "$WORK_DIR/bun.zip" -d "$WORK_DIR"
install -m 700 "$WORK_DIR/bun-darwin-${BUN_ARCH}/bun" "$INSTALL_DIR/bun"
rm -rf "$WORK_DIR"

"$INSTALL_DIR/bun" --version
