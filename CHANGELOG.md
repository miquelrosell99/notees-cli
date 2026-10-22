# Changelog

The record of shipped work for the Notees CLI. One entry per shipped slice,
newest first. This file — not `AGENTS.md`, not the README — is where history
goes; those stay static guidance. Before implementing a change, skim this
file for recent related work. Anything before 2026-10-06 lives in git
history.

## 2026-10-22

- **fix(test): the suite blanks leaked `NOTEES_*` operator env for its
  duration — the gate is environment-independent.** The fleet host's shell
  exports `NOTEES_SERVER=http://localhost:8377`, which made the "missing
  server → usage error (2)" test hit the live stack with the fake test key
  and return auth (3) — a red gate that depended on what the operator shell
  happened to carry, not on the code. `beforeAll` now saves and clears
  `NOTEES_SERVER` / `NOTEES_WORKSPACE` / `NOTEES_API_KEY` / `NOTEES_EMAIL` /
  `NOTEES_PASSWORD` (every var `src/` reads), `afterAll` restores them, and
  `NOTEES_STATE_FILE` isolation is unchanged. Behavior change: none — test
  harness only.
  - **Verification**: `pnpm test` 87/87 **with the leak vars deliberately
    exported** (`NOTEES_SERVER`, `NOTEES_WORKSPACE`, a decoy
    `NOTEES_API_KEY`) — the exact combination that failed before the fix;
    `pnpm typecheck` clean; `pnpm build` succeeds.
  - **Files**: `test/cli.test.ts`.

- **chore(vendor): vendor pin re-pointed at main `33e4af5e2 → bc3f856e7` —
  carrying the WS admission tickets (the `?token=` retirement).** The main
  repo retired the credential-in-URL fallback: the sync socket now admits
  `Authorization: Bearer` (native clients) or a single-use `?ticket=ntk_…`
  minted at `POST /api/relay/v2/tickets` (browsers), and `?token=` is rejected
  on the whole API. Zero CLI-code delta (the lockstep law — the vendored
  `packages/sync` transport mints tickets internally; its public options are
  unchanged), and no CLI surface ever put a credential in a URL — the REST
  client has always sent headers. GTK (`8269285`) and Flutter (`f9cfe75`)
  converged the same day, closing the three-implementation lockstep.
  - **Verification**: `pnpm -r --filter "@notees/*" build` + `pnpm typecheck`
    clean; `pnpm test` 87/87 (with `NOTEES_SERVER` unset — the known
    env-leak note from the previous entry).
  - **Files**: `vendor/notees` (the pin).

- **chore(vendor): vendor pin re-pointed AGAIN at the rewritten main — `a4796bda3 →
  33e4af5e2` — the releases.md scrub.** The main repo's history was rewritten a
  second time 2026-10-22 (every trace of the retired `docs/developers/releases.md`
  scrubbed via `git filter-repo`; all SHAs changed again), invalidating the
  morning's pin. The new pin's tree is content-identical at the tip (the scrub
  only rewrites history, not content), so the vendored packages carry the same
  system-extends lock — no functional delta.
  - **Verification**: `pnpm -r --filter "@notees/*" build` + `pnpm build` +
    `pnpm typecheck` clean; `pnpm test` 87/87 (with `NOTEES_SERVER` unset —
    see the previous entry's note).
  - **Files**: `vendor/notees` (the pin).

- **chore(vendor): vendor pin re-pointed at the rewritten main — `278fb7cfe →
  a4796bda3` — carrying the system-extends lock (and the readonly +
  binding-sequence retirements).** The main repo's history was rewritten
  2026-10-22 (every live compose file scrubbed from all commits via
  `git filter-repo`; all old SHAs changed), so the recorded pin
  `278fb7cfe` no longer exists upstream — this bump is also the repair that
  makes a fresh `git submodule update --init` work again. The new pin rides
  three slices, all with zero CLI-code delta (the lockstep law — the pin is
  the boundary):
  - **The system-extends lock**: `class.setExtends`
    on a system class applies only when the payload equals the seeded parent
    set; deviations fail loud with `SystemExtendsLockError`. Applier-side in
    the vendored `@notees/store`; the CLI's `class.extends`-family writes
    ride it automatically (fixture gate 36→37, `class-extends-system-lock.json`;
    GTK v4.3.0 / Flutter v4.2.0 converged byte-identical before the bump).
  - **The `readonly` retirement**: clients derive
    readonly-ness from the system property list; the CLI never authored the
    flag — no delta.
  - **The binding-`sequence` retirement**: the
    binding is strictly `{classId, propertySchemaId, active?}` — the CLI
    never authored `sequence` — no delta.
  - **Verification**: `pnpm -r --filter "@notees/*" build` + `pnpm build` +
    `pnpm typecheck` clean; `pnpm test` 87/87 (run with `NOTEES_SERVER`
    unset — a session-inherited `NOTEES_SERVER` pointing at a live stack
    makes the "missing server → exit 2" test hit the real server and 401;
    environmental, not a regression).
  - **Files**: `vendor/notees` (the pin).

## 2026-10-21

- **feat(content,model): the CLI rides the external_link retirement AND the
  property-definition batch — vendor pin `668a835b → 278fb7cfe`.** The pin
  crosses three breaking slices on the main repo's main; the CLI follows all
  of them (the lockstep law — the pin is the boundary, the CLI rides what it
  carries):
  - **`external_link` retires** (main commit `077f84b1`; normative grammar in
    SCHEMA.md): links are markdown `[label](href)` spans inside ordinary
    `text` tokens, parsed at render time; the retired token no longer passes
    the strict content schema. The `--content` help text and docs comment
    describe links as `[label](href)` spans in text tokens instead of
    external links as a token type; the e2e `--content` test stores and
    round-trips a text token carrying a markdown link next to a mention (the
    old `external_link` payload is a strict-schema 422 now). The markdown
    exporter needed no CLI-side change: it delegates to the vendored
    `@notees/export` serializer, whose `renderSpan` text case splits links
    with `splitMarkdownLinks` (`@notees/domain`) and emits link segments
    verbatim while escaping non-link segments — previously `external_link`
    tokens were silently dropped.
  - **Binding `sequence`/`required` retire; `defaultValue` moves to the
    property schema** (main `26a19684b` + `71047ba5a`): `class.property.set` is strictly
    `{classId, propertySchemaId, active?}` — the strict schema rejects
    `sequence`, `required`, and `defaultValue` like any retired key, and
    class properties render as a pure alphabetical list by property name.
    `property bind` drops `--sequence`, `--required/--no-required`,
    `--readonly/--no-readonly`, `--hideWhenEmpty/--no-hideWhenEmpty`, and
    `--default` (the main repo's docs flagged this as the pending CLI
    lockstep follow-up); the one global default is now
    `property create --default <json>` (typed per the schema type at apply —
    a wrong-typed default is a server-side 422). The shell's
    `setClassProperty` doc comments follow; the e2e property + shell tests
    re-anchor to the presence-only binding and the schema-level default.
  - **Schema `readonly` retires** (main `4eda19e07`): never user
    configuration — clients derive readonly-ness from the system property
    list (`isReadonlyProperty`, `@notees/domain`); the CLI never surfaced
    the flag on the schema verbs, so no CLI change beyond the bind flags
    above.
  - **`CLI_VERSION` 4.1.1 → 4.4.0** — the vendored server rejoined the tag
    train at 4.4.0 (`SERVER_VERSION`), and `CLI_VERSION` rides the server's
    release train; `doctor`'s drift check compares against it.
  Gate: `pnpm typecheck && pnpm test` green (87 tests; run with a clean
  environment — a `NOTEES_SERVER` env var leaks a server into the
  missing-server usage test, which then exits 3 against that server instead
  of 2).

## 2026-10-20

- **feat(model): the CLI rides the property-scope retirement batch —
  scopeClassIds is the sole locality authority.** The main monorepo retired
  the display-only `scope: "global"|"class"|"object"` enum (rejected outright
  like any retired key; live logs rewrite in place via
  `scripts/migrate-property-scope.mts`) and made a schema's `scopeClassIds`
  (absent/null = global; a non-empty class list = local to those classes and
  their extends-ancestors) the only thing that says who may carry a property.
  The batch also added the schema `icon`, update-side
  `targetClassFilter`/`multi`/`validationRules` (min/max/pattern, enforced at
  `property.set`), the R3/R5 eligibility guards (ineligible authored values
  read tagged `eligible: false`, never derived), and the node `listStyle`
  (numbered/alpha/roman). The CLI follows: vendor pin bumped
  `0033e84b → 668a835b` (the batch's convergence commit on the main repo's
  main); `property create` and the bibtex import's system-schema get-or-create
  stop sending the retired `scope` key (global is the absence of
  `scopeClassIds`; the server's strict payload rejected the old spelling with
  a 422); `property list`'s SCOPE column renders the locality from
  `scopeClassIds`, resolving class ids to titles via one `/api/classes` call
  (ids with no live class row fall back to the raw id; `--json` keeps passing
  the server rows through verbatim, now carrying `scopeClassIds`, `icon`, and
  `validationRules`); `--targetClass` keeps feeding `targetClassFilter`
  (unchanged semantics — node-typed target constraint, orthogonal to
  locality). Gate: `pnpm typecheck && pnpm test` green (87 tests; the retired-
  scope fixtures in the suite drop the enum the way the wire now demands).

## 2026-10-13

- **feat(merge): `notees object merge <source> <target>` — merge one object
  into another, preview-first.** The main monorepo shipped node merge as a
  planner over the derived store (a batch of existing op types — no wire
  change) exposed at `POST /api/objects/:id/merge` with a `?dryRun=true`
  preview; the CLI rides it. The command resolves both nodes, honors the
  destructive-command contract (`--dry-run` prints the plan's counts and
  writes nothing; without `--yes` it prints the blast radius to stderr and
  exits 2; `--yes` merges), and reports the server's plan summary in human
  text and `--json` (`{source, target, merged, summary}` — additive shape).
  Semantics (SCHEMA.md "Node merge"): the source's children move, class/tag
  bindings and authored properties remap (the target keeps values it already
  has), references retarget (mentions, property references, aliases,
  collections), and the source trashes. Vendor pin bumped `af57c5bb →
  1b89adf0` (the merge slice's commit on the main repo's main). Gate: `pnpm
  typecheck && pnpm test` green (87 tests, incl. the new `object merge`
  preview/merge/guard specs).

## 2026-10-09

- **chore(release): v4.1.0 — the CLI rides the unified-datetime batch's
  minor.** `CLI_VERSION` 4.0.0 → 4.1.0 (the server train shipped the batch as
  the v4.1.0 minor; the GTK client tagged v4.1.0 in lockstep), the PKGBUILD
  records the deterministic bundle's checksum, and the datetime slice below
  ships with it. Gate: `pnpm typecheck && pnpm test` + `pnpm build` before
  the tag.
- **feat(datetime): the CLI rides the unified-datetime wire batch.** The main
  monorepo retired the `date` / `date_range` property schema types and unified
  on `datetime` (a value is a point `{nodeId, time?}` or a range
  `{start, end}` of `{nodeId, time?}` slots, either side open; full-day is the
  absence of `time`), and the live logs were rewritten by its migration. The
  CLI follows: vendor pin bumped `a317fb67 → af57c5bb` (the batch's
  convergence commit on main), `property create --type` routes `datetime` and
  rejects the retired types client-side (the server's strict enum would 422
  anyway — exit 2 lands first, and the usage message now lists the unified
  enum), and the markdown exporter's reference closure walks the value union —
  range `start`/`end` slots and metadata qualifier refs are collected so the
  bundle resolves their display names instead of leaking raw ids; display
  formatting itself (`<date> HH:MM`, ranges as a start/end map, open side
  `null`) is the vendored exporter's `datetime` branches. Values still pass
  through `object property set` verbatim as JSON — the server is the strict
  shape gate (a malformed `time` 422s → exit 1). Test boot config gained the
  vendored server's new required `signupEnabled: false`; a new suite block
  exercises datetime schema creation, retired-type rejection, point/range/
  open-range round-trips, malformed-time failure, markdown frontmatter
  rendering, and the json-archive surface carrying the union verbatim.
  Gate: `pnpm typecheck && pnpm test` green (85 tests).

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
