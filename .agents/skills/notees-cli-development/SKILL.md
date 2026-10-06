---
name: notees-cli-development
description: Develop the Notees CLI (notees-cli) — the `notees` command-line client consuming the main Notees monorepo via a pinned vendor/notees git submodule. Use when writing or changing CLI code, tests, commands, exporters, or docs in this repo. Covers the submodule lockstep law, the build/test gate, coding conventions, and the changelog-as-record + docs-in-the-same-pass rules.
---

# Notees CLI development

`notees-cli` is a standalone pnpm workspace (Node 22, pnpm 9, TypeScript,
vitest). The `@notees/*` packages are **not** published anywhere: they are
consumed from the pinned `vendor/notees` git submodule as pnpm workspace
projects (`pnpm-workspace.yaml`), and the test suite boots a real
`@notees/server` to exercise the CLI end-to-end. This skill is the working
contract for changing anything in this repo.

Canonical docs: `README.md` (setup, vendored-package sync, versioning) and,
through the submodule, the main repo's `docs/developers/` runbooks.

## Non-negotiable laws

1. **The submodule pin is the lockstep boundary — never edit `vendor/`.** The
   vendored checkout is a snapshot of the main repo with its own lifecycle;
   every fix lands in the main repo first, then arrives here as a pin bump.
   A wire/applier/model change is not done in the main repo until its fixture
   gate converges (TS reference + GTK + Flutter over byte-identical,
   sha256-pinned fixtures in `packages/protocol/fixtures/`) — so the CLI pin
   should only ever move to commits past that gate. Never edit fixture bytes
   anywhere; recipe: `references/development-workflow.md`.
2. **Dev-condition exports.** vitest resolves `src`, `tsc` resolves `dist`.
   After a vendor bump, run `pnpm -r --filter "@notees/*" build` before
   `pnpm typecheck` / `pnpm test`.
3. **The gate is blocking.** Before declaring anything done:
   `pnpm typecheck && pnpm test` — all green.
4. **The changelog is the record.** Before implementing, skim `CHANGELOG.md`
   for recent related work and check `.plans/` for an in-flight proposal
   folder. After shipping, add a `CHANGELOG.md` entry (what shipped,
   verification) in the same pass. A change without its record is not done.
5. **Docs are part of the change.** Same-pass updates to README.md (commands,
   flags, behavior) and command help text.
6. **No-legacy-version-names.** Live version identifiers (`/api/relay/v2`,
   envelope v3, the `notees-json-archive` v1 envelope, `v2.0.0-mN` tags) are
   wire/format facts — keep them exact; never use v1/v2 as narrative-history
   qualifiers in comments/docs/tests, and no M1–M5 milestone labels.
7. **`--json` is the stable machine surface.** The JSON output shape is
   additive-only (agents consume it); human-readable text may change freely.
   Exit codes follow `src/exit-codes.ts` (0 ok, 1 domain, 2 usage, 3 auth,
   4 conflict, 5 network) — a changed exit code is a breaking change.

## Gate before declaring done

```sh
pnpm typecheck && pnpm test   # from the repo root; all green = blocking gate
```

## Read by topic

- **Development workflow** (commands, vendor-bump recipe, test-suite shape,
  conventions) → `references/development-workflow.md`
  (canonical: `README.md` + the main repo's `docs/developers/development.md`
  via the vendor checkout)
