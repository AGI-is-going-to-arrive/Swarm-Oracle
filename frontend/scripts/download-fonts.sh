#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# download-fonts.sh — thin wrapper around the cross-platform Node implementation.
#
# The real logic now lives in download-fonts.mjs (pure Node, no bash/WSL
# dependency). This wrapper is kept for muscle-memory on *nix shells. On
# Windows (no WSL / Git-Bash) run the Node script directly:
#
#   node frontend/scripts/download-fonts.mjs       # or, from frontend/:  npm run fonts
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
exec node "$(dirname "$0")/download-fonts.mjs" "$@"
