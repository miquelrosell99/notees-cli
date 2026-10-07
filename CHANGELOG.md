# Changelog

The record of shipped work for the Notees CLI. One entry per shipped slice,
newest first. This file — not `AGENTS.md`, not the README — is where history
goes; those stay static guidance. Before implementing a change, skim this
file for recent related work. Anything before 2026-10-06 lives in git
history.

## 2026-10-07

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
  docker — tags stay the only release coordinate. Docs: README "Installing"
  + "Versioning", the operations skill (law 1 + `references/releases.md`),
  AGENTS.md's workflow line. The v3.2.1 release was backfilled by hand so
  the install path works today; the workflow takes over from the next tag.
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
