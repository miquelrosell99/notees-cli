# Notees CLI

The `notees` command-line client for [Notees](https://github.com/miquelrosell99/notees) — the object/property/search surface over the server's public API. Split out of the main monorepo (`apps/cli`) to live alongside the other first-class clients ([GTK](https://github.com/miquelrosell99/notees-gtk), [Flutter](https://github.com/miquelrosell99/notees-flutter)).

The CLI talks to a running `notees-sync` server over HTTP. It holds no state of its own beyond a session credential.

## Layout

```
notees-cli/
├── src/                 # the CLI (commander; `notees` bin)
├── test/                # vitest suite (boots a real server from @notees/server)
├── scripts/install.sh   # release-bundle installer (curl | bash)
├── packaging/arch/      # PKGBUILD for pacman (Arch; built from the release assets)
├── vendor/notees/       # git submodule → miquelrosell99/notees (pinned commit)
└── pnpm-workspace.yaml  # consumes @notees/* from the submodule checkout
```

The CLI imports the TypeScript protocol packages (`@notees/protocol`, `@notees/domain`, `@notees/query`, `@notees/export`) and uses `@notees/server` in tests to boot a real server. They are consumed from the `vendor/notees` submodule as pnpm workspace packages — no npm publishing involved (the SDK-publish track is archived in the main repo).

## Getting started

```bash
git clone --recurse-submodules git@github.com:miquelrosell99/notees-cli.git
cd notees-cli
corepack enable && corepack prepare pnpm@9.0.0 --activate
pnpm install
pnpm build        # tsup bundle → dist/cli.js (the `notees` bin)
pnpm test         # vitest (85 tests)
pnpm dev -- --help    # run from source via tsx
```

If you cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

## Configuration

Resolution order for both the server URL and the workspace is: flag (`--server` / `--workspace`) > environment (`NOTEES_SERVER` / `NOTEES_WORKSPACE`) > the stored per-profile default. Persist the defaults once and bare `notees <cmd>` works without any env plumbing:

```bash
notees config set server https://<host>     # stored default server (per --profile)
notees config set workspace <name|id>       # stored default workspace
notees config get server                    # print one stored default
notees config list                          # print both
```

The defaults live in the CLI state file (`~/.notees/state.json`, mode 0600) under a top-level per-profile record — separate from the `servers` map, which is keyed `profile:server`. `notees config` itself needs no server, credential, or env: it only touches the local state file.
## Authentication

Every command takes a credential via `--key` / `NOTEES_API_KEY`, or falls back to the one stored per profile+server in `~/.notees/state.json` (mode 0600):

- `notees auth login --email <email> --password-stdin` — email + password; mints a dedicated CLI API key (revocable from the app) and stores it.
- `notees auth store --key <credential>` (or `--key-stdin`) — probe-verify an existing API key against the server, then store it as the standing credential. Stored keys are not CLI-minted, so `auth logout` clears them locally only — server-side revocation applies to login-minted keys.
- `notees auth status` / `notees auth logout` — probe / clear the stored credential.

## Installing

Every `v*` tag carries a prebuilt bundle (`cli.mjs`, ESM with a `node` shebang, sha256 sidecar) on its GitHub Release, built by `.github/workflows/release.yml`. The install script fetches it, verifies the checksum, and links `notees` into `~/.local/bin` (override with `NOTEES_INSTALL_DIR`):

```bash
curl -fsSL https://raw.githubusercontent.com/miquelrosell99/notees-cli/main/scripts/install.sh | bash
curl -fsSL https://raw.githubusercontent.com/miquelrosell99/notees-cli/main/scripts/install.sh | bash -s -- v3.2.1   # pin a version
```

Requirements: bash, curl, node ≥ 22. The bundle is standalone — no pnpm toolchain, no `vendor/` checkout. Installing from source (above) is the other supported path; there is no npm or docker distribution.

**On Windows:** the installer also writes a `notees.cmd` shim next to the installed files, so cmd/PowerShell can run `notees` directly (Git Bash/MSYS executes the extensionless `notees` via its shebang either way).

**On Arch (pacman):** `packaging/arch/PKGBUILD` builds an installable package from the same release assets — checksum-verified by pacman itself:

```bash
git clone --depth 1 --branch v3.2.3 https://github.com/miquelrosell99/notees-cli.git
cd notees-cli/packaging/arch
makepkg -si        # installs notees-cli + its nodejs>=22 dependency
```

Every tag's `pacman-smoke` CI job build-installs this exact PKGBUILD on Arch before the release is trusted. AUR publication is deliberately deferred — the in-repo PKGBUILD is the supported way to build the package.

## Syncing the vendored packages

The submodule pin is the lockstep boundary: bump it after the main repo ships protocol/store changes the CLI needs.

```bash
cd vendor/notees && git fetch origin && git checkout origin/main && cd ../..
pnpm install
pnpm -r --filter "@notees/*" build   # rebuild the vendored packages' dists
pnpm build && pnpm test
```

Commit the submodule bump — CI installs with `--frozen-lockfile`, so run `pnpm install` once locally to refresh `pnpm-lock.yaml` and commit that too.

## Versioning

`CLI_VERSION` (in `src/cli.ts`) rides the server's release train — the `doctor` command warns when the server is ahead of the CLI. There is no separate npm/docker distribution; install from a release bundle or from source (see "Installing").
