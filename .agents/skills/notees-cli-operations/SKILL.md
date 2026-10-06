---
name: notees-cli-operations
description: Release and package the Notees CLI (notees-cli). Use when cutting a CLI release, bumping CLI_VERSION, bumping the vendor/notees submodule pin, or deciding how the CLI is distributed/installed. Covers the git-tag release mechanism, the server release train, and the never-re-tag law.
---

# Notees CLI operations

The CLI ships as source + git tags — there is no npm publication, no docker
image, no GitHub-Release artifact, and no release workflow in CI
(`.github/workflows/ci.yml` is build+test only). Releases ride the server's
release train: `CLI_VERSION` (in `src/cli.ts`) tracks the main repo's server
version, and the `doctor` command warns when the server is ahead of the CLI.

Canonical detail: `references/releases.md`; the deployment it talks to on the
fleet host is the main repo's `notees-sync` + `notees-web` docker compose
stack (see the main repo's `docs/developers/deployment.md`).

## Non-negotiable laws

1. **Git tags are the release mechanism.** A release = a `vX.Y.Z` tag whose
   version matches `CLI_VERSION` in `src/cli.ts`, cut after the gate is green
   (`pnpm typecheck && pnpm test`, plus `pnpm build`). The version is
   informational — consumers install from source at a tag.
2. **Never re-tag a release.** Same-day correction = next patch tag.
3. **A vendor bump is not a release by itself.** Bump the `vendor/notees`
   pin when the main repo ships protocol/store changes the CLI needs (recipe
   in the development skill); tag when a user-visible CLI slice ships.
4. **The CLI never pins the server.** It talks to whatever `notees-sync`
   endpoint the user points it at; version drift is surfaced by `doctor`,
   not enforced.
5. **Fleet-agnostic artifacts** — never hardcode host names, IPs, or tailnet
   names in code, docs, or release notes; write `<host>`, `<tailnet>`, "the
   fleet host".

## Read by topic

- **Releases & packaging** (tag mechanics, version train, install paths,
  fleet-host consumption) → `references/releases.md`
