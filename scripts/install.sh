#!/usr/bin/env bash
# Install the `notees` CLI from a release bundle.
#
#   curl -fsSL https://raw.githubusercontent.com/miquelrosell99/notees-cli/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/miquelrosell99/notees-cli/main/scripts/install.sh | bash -s -- v3.2.1
#
# The script downloads the tag's `cli.mjs` bundle (+ sha256, verified before
# install), places it as `notees.mjs` in the install dir, and symlinks
# `notees` next to it. Requires bash, curl, and node (>= 22) on PATH.
#
# Env overrides:
#   NOTEES_INSTALL_DIR    where `notees` lands (default: ~/.local/bin)
#   NOTEES_VERSION        release to install when no argument is given
#   NOTEES_RELEASE_BASE   download base (default: this repo's GitHub releases;
#                         override for mirrors or file-based testing)
set -euo pipefail

REPO="miquelrosell99/notees-cli"

VERSION="${1:-${NOTEES_VERSION:-latest}}"
case "$VERSION" in
  latest) ;;
  v*) ;;
  *) VERSION="v$VERSION" ;;
esac

INSTALL_DIR="${NOTEES_INSTALL_DIR:-$HOME/.local/bin}"
RELEASE_BASE="${NOTEES_RELEASE_BASE:-https://github.com/$REPO/releases/download}"

log() { printf 'notees-install: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required on PATH"
command -v node >/dev/null 2>&1 || die "node (>= 22) is required on PATH"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || die "node >= 22 is required (found $(node --version))"

if [ "$VERSION" = "latest" ]; then
  # /releases/latest redirects to the newest tag — the final URL carries it,
  # no JSON parsing needed.
  resolved="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" \
    || die "cannot resolve the latest release (network or repo unreachable)"
  VERSION="${resolved##*/}"
fi
[ -n "$VERSION" ] && [ "$VERSION" != "latest" ] || die "could not resolve a release version"

BASE="$RELEASE_BASE/$VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "downloading $VERSION from $BASE"
curl -fsSL "$BASE/cli.mjs" -o "$TMP/cli.mjs" || die "no cli.mjs bundle for $VERSION (release assets missing?)"
curl -fsSL "$BASE/cli.mjs.sha256" -o "$TMP/cli.mjs.sha256" || die "no cli.mjs.sha256 checksum for $VERSION"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$TMP" && sha256sum -c cli.mjs.sha256 >/dev/null) || die "checksum mismatch for cli.mjs — refusing to install"
else
  (cd "$TMP" && shasum -a 256 -c cli.mjs.sha256 >/dev/null) || die "checksum mismatch for cli.mjs — refusing to install"
fi

mkdir -p "$INSTALL_DIR"
if ! cp "$TMP/cli.mjs" "$INSTALL_DIR/notees.mjs" 2>/dev/null; then
  die "cannot write to $INSTALL_DIR (permission? set NOTEES_INSTALL_DIR)"
fi
chmod 0755 "$INSTALL_DIR/notees.mjs"
ln -sfn "notees.mjs" "$INSTALL_DIR/notees"

# Sanity: the installed symlink must answer --help through node.
"$INSTALL_DIR/notees" --help >/dev/null 2>&1 || die "installed binary failed to run — check node >= 22"

log "installed notees $VERSION into $INSTALL_DIR (notees -> notees.mjs)"
log "make sure $INSTALL_DIR is on PATH"
