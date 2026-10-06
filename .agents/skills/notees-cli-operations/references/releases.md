# Releases & packaging

Canonical: `README.md` ("Versioning", "Syncing the vendored packages") + the
main repo's `docs/developers/releases.md` (through the `vendor/notees`
checkout). The deployment the CLI talks to is the main repo's compose stack
(`notees-sync` :8377 + `notees-web` :8378); operate that stack with the
main repo's `notees-operations` skill, not this one.

## Release mechanism: git tags, riding the server's train

- There is **no** npm publication, **no** docker image, **no** GitHub-Release
  artifact, and no release workflow — `.github/workflows/ci.yml` only
  builds and tests on push/PR.
- `CLI_VERSION` (in `src/cli.ts`) rides the main repo's server release train
  (e.g. tag `v3.2.0` ↔ `CLI_VERSION = "3.2.0"`). The `doctor` command
  compares the server's version against `CLI_VERSION` and warns when the
  server is ahead ("rebuild the CLI — response shapes may be stale").
- A release is a `vX.Y.Z` git tag on `main`, cut after the gate is green:
  `pnpm typecheck && pnpm test` (plus `pnpm build`). The tag is the
  reference point for source installs; the version string is informational.

## Cutting a release

1. Land the change on `main` with its `CHANGELOG.md` entry and a green gate.
2. Bump `CLI_VERSION` in `src/cli.ts` to match the server train version.
3. `pnpm typecheck && pnpm test && pnpm build`.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`.

**Never re-tag.** Same-day correction = next patch tag. Tags are the only
release coordinate; moving one breaks "which source is this install".

## Installing / consuming

- Install from source: clone with `--recurse-submodules`, `pnpm install`,
  `pnpm build`, put `dist/cli.js` (the `notees` bin) on PATH — or run via
  `pnpm dev`.
- On the fleet host the CLI is installed from source against the local
  `notees-sync` deployment; point it with `--server` / `NOTEES_SERVER` and a
  credential (`--key` / `NOTEES_API_KEY`, or `notees auth login`). Never
  hardcode the host's name/IP in docs or scripts — `<host>` / `<tailnet>`.

## Vendor bumps vs releases

- A `vendor/notees` pin bump tracks the main repo's protocol/store changes
  (recipe in the development skill's `development-workflow.md`); it does not
  require a tag.
- Tag when a user-visible CLI slice ships (new/changed commands, flags,
  output contracts) or when the version train moves.
