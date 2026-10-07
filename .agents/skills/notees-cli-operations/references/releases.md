# Releases & packaging

Canonical: `README.md` ("Versioning", "Syncing the vendored packages") + the
main repo's `docs/developers/releases.md` (through the `vendor/notees`
checkout). The deployment the CLI talks to is the main repo's compose stack
(`notees-sync` :8377 + `notees-web` :8378); operate that stack with the
main repo's `notees-operations` skill, not this one.

## Release mechanism: git tags + an attached bundle

- There is **no** npm publication and **no** docker image; `.github/workflows/ci.yml`
  remains build+test only. Tags additionally carry a **release bundle**:
  `.github/workflows/release.yml` runs on `v*` tag pushes, re-runs the gate
  (vendored build, typecheck, test), builds `dist/cli.js`, and attaches it to
  the tag's GitHub Release as `cli.mjs` + `cli.mjs.sha256` (named `.mjs` so
  the standalone ESM bundle keeps its module type without a package.json).
- `CLI_VERSION` (in `src/cli.ts`) rides the main repo's server release train
  (e.g. tag `v3.2.0` ↔ `CLI_VERSION = "3.2.0"`). The `doctor` command
  compares the server's version against `CLI_VERSION` and warns when the
  server is ahead ("rebuild the CLI — response shapes may be stale").
- A release is a `vX.Y.Z` git tag on `main`, cut after the gate is green:
  `pnpm typecheck && pnpm test` (plus `pnpm build`). The tag is the
  reference point for source installs; the attached bundle is the
  no-toolchain install path (see below).
- The same release feeds the **pacman package**: `packaging/arch/PKGBUILD`
  builds from the tag's release assets with pacman-side checksum
  verification. The workflow greps the staged bundle's sha256 into the
  PKGBUILD before publishing (a stale checksum fails the release), and a
  `pacman-smoke` job build-installs the package on an Arch container and runs
  the packaged `notees`. AUR publication is deliberately deferred — the
  in-repo PKGBUILD is the supported way to build it.

## Cutting a release

1. Land the change on `main` with its `CHANGELOG.md` entry and a green gate.
2. Bump `CLI_VERSION` in `src/cli.ts` to match the server train version.
3. Rebuild and update `packaging/arch/PKGBUILD` — `pkgver` and
   `sha256sums[0]` must match the new tag's assets (the build is
   deterministic: `pnpm build && sha256sum dist/cli.js` at the final tree
   gives the value; the workflow re-verifies it before publishing).
4. `pnpm typecheck && pnpm test && pnpm build`.
5. `git tag vX.Y.Z && git push origin vX.Y.Z` — the release workflow gates,
   checks the PKGBUILD checksum, creates the GitHub Release with the assets,
   and runs the pacman smoke; no manual `gh release create` step.

**Never re-tag.** Same-day correction = next patch tag. Tags are the only
release coordinate; moving one breaks "which source is this install".

## Installing / consuming

- **From a release bundle** (no toolchain): `scripts/install.sh` downloads
  the tag's `cli.mjs` + checksum, verifies it, and links `notees` into
  `~/.local/bin` (override `NOTEES_INSTALL_DIR`):
  `curl -fsSL https://raw.githubusercontent.com/miquelrosell99/notees-cli/main/scripts/install.sh | bash`
  (append a version to pin: `| bash -s -- v3.2.1`). Requires bash, curl,
  node ≥ 22.
- **On Arch**: `packaging/arch/PKGBUILD` — `makepkg -si` from a tag checkout
  (see the README). AUR publication is deferred; this file is the supported
  build.
- **From source**: clone with `--recurse-submodules`, `pnpm install`,
  `pnpm build`, put `dist/cli.js` (the `notees` bin) on PATH — or run via
  `pnpm dev`.
- On the fleet host the CLI is installed against the local `notees-sync`
  deployment; point it with `--server` / `NOTEES_SERVER` and a credential
  (`--key` / `NOTEES_API_KEY`, or `notees auth login`). Never hardcode the
  host's name/IP in docs or scripts — `<host>` / `<tailnet>`.

## Vendor bumps vs releases

- A `vendor/notees` pin bump tracks the main repo's protocol/store changes
  (recipe in the development skill's `development-workflow.md`); it does not
  require a tag.
- Tag when a user-visible CLI slice ships (new/changed commands, flags,
  output contracts) or when the version train moves.
