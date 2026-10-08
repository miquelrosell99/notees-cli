# Changelog

The record of shipped work for the Notees CLI. One entry per shipped slice,
newest first. This file — not `AGENTS.md`, not the README — is where history
goes; those stay static guidance. Before implementing a change, skim this
file for recent related work. Anything before 2026-10-06 lives in git
history.

## 2026-10-08

- **chore(release): v4.0.0 — the CLI rides the server's major.** The brand
  slice + the covers slice ship as the CLI's v4.0.0: `CLI_VERSION` 3.2.3 →
  4.0.0 (the server shipped v4.0.0 with the Margin Green identity), the
  PKGBUILD records the deterministic bundle's checksum, and release.yml's
  pacman-smoke now fetches the vendored icon beside the PKGBUILD. Gate:
  `pnpm typecheck && pnpm test` + `pnpm build` before the tag.
- **feat(packaging): the pacman package ships the brand app icon.**
  `packaging/arch/PKGBUILD` vendors the Margin Green app icon (512, from the
  `notees-brand` repo) and installs it into the hicolor theme, so desktop
  environments and package managers show the mark. Verification: PKGBUILD
  syntax + vendored sha256 recomputed and recorded.
- **feat(covers): the cover command rides the `coverAssetId` wire node field.**
  The main monorepo made `coverAssetId` / `bannerAssetId` / `aliasedNodeId`
  wire node fields on `object.update` (optional nullable; present writes,
  present-null clears) and exposed them on every REST object projection,
  superseding the retired image-typed `cover` property schema (the stored
  logs were rewritten by the monorepo migration). The CLI follows: `cover
  set` / `cover get` / `cover clear` read `object.coverAssetId` and write via
  `PATCH /api/objects/:id { coverAssetId }` (null clears) instead of the
  property POST/DELETE; the `ensureCoverProperty` family ensure died with the
  retired schema — the asset class root the upload flow needs is seeded by
  the server on workspace bootstrap, so no ensure remains. Vendor pin bumped
  `5e707374 → a317fb67` (the first commit exposing the fields on the REST
  object API). Tests: the covers block asserts the field end-to-end against
  the real vendored server; the retired `prop:cover:` exists-arm search test
  now POSTs the `{type:"coverAsset", op:"exists"}` AST programmatically (the
  query compiler accepts the wire-field predicates, but the query-language
  grammar has no spelling for them yet — that production lands separately).
  Gate: `pnpm typecheck && pnpm test` green (84 tests), full workspace build
  green.
- **feat(cli): align the CLI to the Margin Green brand tokens.** The brand
  identity ("MARGIN — the page is the canvas; the margin is where thought
  accumulates") now lives in this repo as a git submodule at `brand/`
  (pinned to `v1.0.0`, <https://github.com/miquelrosell99/notees-brand>) —
  the single source of truth every client consumes. Survey of the CLI's
  brand surfaces: the tool emits plain text only (no ANSI colour, no
  colour dependency, no hard-coded hex anywhere in `src/`, tests, scripts,
  or packaging), so there were no terminal colours to remap; `doctor`'s
  ok/FAIL markers and the `notees` shell prompt stay unstyled, and the
  README carries no logo or badge block (left as-is). The submodule is
  wired in so future coloured output derives from `brand/assets/tokens/`
  (Advance Green `#2e5e46`, Iron Ink `#1c1a16`, Paper `#f7f4ec`,
  Night `#161412`). Verification: `pnpm typecheck && pnpm test` — 84/84
  green.

## 2026-10-07

- **fix(release): the pacman package installs the bundle executable.**
  `install -Dm644` in the PKGBUILD left `/usr/lib/notees-cli/cli.mjs`
  non-executable; `/usr/bin/notees` symlinks straight at it, so the packaged
  CLI died with "Permission denied" (exit 126) — caught by the new
  `pacman-smoke` job on the v3.2.2 tag (its release assets are unaffected;
  install.sh there works fine). Fixed mode 0755. Per the never-re-tag law
  the correction rides the next patch tag, v3.2.3.
- **feat(release): pacman packaging — `packaging/arch/PKGBUILD` + release.yml
  checksum gate + Arch smoke job.** Every tag now also feeds a pacman
  package: the PKGBUILD builds from the tag's release assets (`cli.mjs` +
  sha256 sidecar, LICENSE from the tag; `depends nodejs>=22`; AGPL-3.0-or-later;
  `/usr/bin/notees → /usr/lib/notees-cli/cli.mjs`). The workflow greps the
  staged bundle's sha256 into the PKGBUILD before publishing (a stale
  checksum fails the release), and a `pacman-smoke` job build-installs the
  package on an `archlinux` container via `makepkg` and runs the packaged
  binary. AUR publication is deliberately deferred — the in-repo PKGBUILD is
  the supported build. Docs: README Installing (pacman subsection + layout
  tree), the operations skill (mechanism + cutting steps), AGENTS.md. The
  fleet host runs Debian, so this tier targets Arch workstations; install.sh
  stays the fleet path. Part of v3.2.2, the first tag released through the
  workflow.
- **fix(cli): the direct-execution guard follows symlinks.** The
  `invokedDirectly` check compared `import.meta.url` (resolved realpath)
  against `argv[1]` as typed, so invoking the CLI through a symlink — what
  `install.sh` creates (`notees → notees.mjs`) and what the pacman package
  creates under `/usr/bin` — silently no-opped with exit 0. Both spellings
  are now compared; `install.sh`'s sanity check requires a version-shaped
  `--version` output (a bare exit code also passes when the binary no-ops).
  Found by testing the installed symlink against the live server.
- **feat(release): tags carry an installable bundle — `release.yml` workflow
  + `scripts/install.sh`.** A `v*` tag push now builds `dist/cli.js` in CI
  (vendored build + typecheck + test + bundle, mirroring the release gate)
  and attaches it to the tag's GitHub Release as `cli.mjs` + a sha256
  sidecar — `.mjs` so the standalone ESM bundle keeps its module type
  without a package.json beside it. `scripts/install.sh` fetches a release
  (default latest, resolvable offline via the `/releases/latest` redirect),
  verifies the checksum (sha256sum/shasum portable), needs node ≥ 22, and
  links `notees → notees.mjs` into `~/.local/bin` (override
  `NOTEES_INSTALL_DIR`; `NOTEES_RELEASE_BASE` mirrors/testing). No npm, no
  docker — tags stay the only release coordinate. The bundle is
  self-contained: tsup compiles every runtime dependency in
  (`noExternal` for the `@notees/*` packages + commander, with a
  `createRequire` banner shim — the first backfilled asset was not
  standalone and was replaced). Docs: README "Installing" + "Versioning",
  the operations skill (law 1 + `references/releases.md`), AGENTS.md's
  workflow line. The v3.2.1 release was backfilled by hand so the install
  path works today; the workflow takes over from the next tag.
  Verification: gate re-run green; install.sh exercised end-to-end against
  the live release (checksum verify + `notees doctor` from the installed
  symlink).

- **feat: graph-migration ergonomics — scoped bulk class ops, rich-content
  flags, children windowing, uuid query refs, shell script files.** Grown
  from a real 468-node migration (the MakerWorld "modelo 3D" → "Web link"
  class move with the tag preserved as a Description mention): the friction
  points became first-class surface.
  - `class remap` gains `--parent <id>` (scope the move to members whose
    direct parent is the given node — subtree-wide scoping rides the query
    language) and `--jobs <n>` (member moves run in a concurrency pool,
    default 8, cap 32; membership is an OR-Set so moves are order-free).
    `class empty` / `class delete-members` gain the same `--parent` scope.
    Scoped member lists resolve through the objects endpoint (class × parent
    filter, cursor-followed) because the class-detail payload carries no
    parent ids.
  - `object create` / `object update` gain `--content <json>`: a contentAst
    token array for rich content (mentions, external links) without dropping
    into the shell; mutually exclusive with `--name` (name IS single-token
    content), non-array JSON fails as usage. Note the standing model
    invariant: root pages/classes carry text-only content — rich tokens on a
    parentless create flatten server-side (the suite pins this).
  - `object children` gains client-side windowing over the (unpaginated)
    endpoint: `--offset`/`--limit` (machine surface reports `total`
    alongside the window), `--count`, and `--fields a,b,c` projection (`id`
    always kept).
  - `search` query language: `class:`, `prop:`, and `linked:` accept uuids
    verbatim (name-or-uuid refs, like `object list --class`), with the
    `linked:` uuid prefetch skipped — no name lookup needed or possible.
  - `notees shell [script]` runs a script file instead of piped stdin (the
    REPL stays TTY-only); the help header now states the vm has no
    `require`/`fs` so ids are fed inline or via a file.
  - `object property set` help documents the `{"nodeId":"…"}` carrier-block
    ref shape for text values (the shape the graph actually stores).
  - Verification: `pnpm typecheck && pnpm test` — 84/84 green, incl. new
    coverage for every flag above.

## 2026-10-06

- **chore(docs): plan-era record keeping retired; `CHANGELOG.md` becomes the
  record.** Same treatment as the main repo: the plan §-citations in code
  comments, test titles, and docs (`§34.28 #13`, `§34.32 PG7`, `§34.16.3`,
  `§34.74`, `§34.59`, `§3`, the README's `§34.82` split-out note, …) are gone
  — the text stands without the citation tokens; the main-repo plan pointer
  in the README is deleted; narrative v1/v2 qualifiers ("Notees v2 CLI",
  "the v1 migration", "the M1 CLI", the M1 drift/person-match notes) are
  reworded without the labels. Deliberate exceptions, per the main repo's
  policy: live version identifiers stay exact — `/api/relay/v2` paths, the
  envelope, the `notees-json-archive` v1 envelope format, `v2.0.0-mN` git
  tags — and the arbitrary test-data strings (`t1-cli-page-v2`) are data, not
  history. `AGENTS.md` created as static guidance (layout, commands,
  invariants, records index); the `notees-cli-development` +
  `notees-cli-operations` project-skill pair added under `.agents/skills/`.
  No logic, symbol, or assertion changes; gate re-run green.
