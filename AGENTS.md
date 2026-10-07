# AGENTS.md

Notees CLI — the `notees` command-line client for Notees: the
object/property/search surface over the server's public API, plus markdown /
JSON-archive export and a scripting REPL (`notees shell`). A standalone pnpm
workspace (Node 22, pnpm 9, TypeScript, vitest) that consumes the main
monorepo's TypeScript packages (`@notees/protocol`, `@notees/domain`,
`@notees/query`, `@notees/export`; `@notees/server` for the test suite) from a
**pinned git submodule at `vendor/notees`** — never edit anything under
`vendor/` (it is a snapshot of the main repo with its own lifecycle).

## Skills (mandatory)

```
AGENTS.md
    │
    ├── notees-cli-development    (project skill — .agents/skills/notees-cli-development/)
    │      └── development workflow  → references/development-workflow.md
    ├── notees-cli-operations     (project skill — .agents/skills/notees-cli-operations/)
    │      └── releases & packaging → references/releases.md
    └── notees-cli-manipulation   (project skill — .agents/skills/notees-cli-manipulation/)
           └── graph-data edits via the CLI (class migrations, carrier blocks, bulk jobs)
```

- **Any code, test, or doc change → invoke the `notees-cli-development` skill
  first** and follow its laws (submodule lockstep, gate-before-done,
  changelog-as-record, docs-in-the-same-pass).
- **Any release, versioning, or submodule-bump task → invoke the
  `notees-cli-operations` skill first.**
- **Any task that edits graph data through the CLI (retagging, Description
  links, batch node edits) → invoke the `notees-cli-manipulation` skill
  first** (its model facts — carrier-block refs, the root-flatten invariant,
  idempotent membership — decide whether a script is safe to re-run).
- The skills summarize and enforce; their references point at the canonical
  homes (README.md here, and the main repo's `docs/developers/` runbooks
  through the vendor checkout). Content is referenced, not duplicated —
  update skill + doc in the same pass.

## Layout

- `src/` — the CLI (`cli.ts` commander program + `notees` bin entry;
  `shell.ts` the scripting REPL; per-concern modules: `client.ts` fetch
  client, `exit-codes.ts` the exit-code contract, `state.ts` the local state
  file, `json-export.ts` / `markdown-export.ts` the exporters, `util.ts`,
  `uuid.ts`)
- `test/` — vitest suite; boots a **real** server from `@notees/server`
  against a temp workspace (`vitest.config.ts` deliberately excludes the
  vendored packages' own suites)
- `vendor/notees/` — git submodule → the main repo (pinned commit);
  `pnpm-workspace.yaml` consumes its packages as workspace projects
- `.github/workflows/ci.yml` — install (`--frozen-lockfile`,
  `submodules: recursive`) + build + test on push/PR

## Commands

- Setup: `git submodule update --init` (if cloned without
  `--recurse-submodules`) → `corepack enable && corepack prepare pnpm@9.0.0 --activate`
  → `pnpm install`
- Build: `pnpm build` (tsup bundle → `dist/cli.js`, the `notees` bin). After a
  vendor bump, first `pnpm -r --filter "@notees/*" build` to rebuild the
  vendored packages' dists (dev-condition exports: tsc reads `dist`).
- Test: `pnpm test` (vitest) · Typecheck: `pnpm typecheck` (`tsc --noEmit`)
- **Gate before declaring done: `pnpm typecheck && pnpm test` — all green.**
- Run from source: `pnpm dev -- --help` (tsx).

## Invariants / conventions

- **The submodule pin is the lockstep boundary.** Wire/applier/model changes
  arrive only via a vendor bump after the main repo's fixture gate (TS
  reference + GTK + Flutter over byte-identical, sha256-pinned fixtures) has
  converged. Never edit `vendor/` — fix it in the main repo, then bump the
  pin. Never edit fixture bytes anywhere.
- **The CLI holds no object state** — no local database; the only state is the
  session credential + workspace cursor in `~/.notees/state.json` (mode 0600)
  and the resolved name→workspace-id cache.
- **Exit-code contract** (`src/exit-codes.ts`): 0 ok, 1 domain, 2 usage,
  3 auth, 4 conflict, 5 network. Wire errors map onto these codes.
- **`--json` is the stable machine surface**: the JSON output shape is
  additive-only (agents consume it); human-readable text may change freely.
- **No client-side shape checks on credentials** — the client sends the
  credential verbatim and maps the server's 401.
- **No-legacy-version-names**: live version identifiers (`/api/relay/v2`,
  envelope v3, the `notees-json-archive` v1 envelope, `v2.0.0-mN` git tags)
  are wire/format facts and stay exact — never use v1/v2 as prose qualifiers
  for history, and no milestone labels (M1–M5).
- **Fleet-agnostic artifacts**: never hardcode host names, IPs, or tailnet
  names in code or docs — write `<host>`, `<tailnet>`, "the fleet host".
  Concrete values live only in gitignored env files / operator config.

## Records index (scan, don't embed)

| Record | Home |
|--------|------|
| Shipped work | `CHANGELOG.md` (newest first, one entry per slice) |
| In-flight proposals | `.plans/YYYY-MM-DD-HHMM-<slug>/` (date-stamped proposal folders, created on demand) |
| Project skills | `.agents/skills/` |

## Working rules (owner)

- **The changelog is the record**: what shipped and why lives in
  `CHANGELOG.md` at the repo root — one entry per shipped slice, newest
  first. `AGENTS.md` itself is static guidance: never append history, dates,
  or work-record entries to it; edit it only when the guidance changes.
  Before implementing, skim `CHANGELOG.md` for recent related work and check
  `.plans/` for an in-flight proposal folder. A change without its changelog
  + doc updates is not done.
- **Docs are part of the change**: any behavior, command, or flag change
  updates README.md (and the help text) in the same pass.
