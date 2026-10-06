# Development workflow

Canonical: `README.md` in this repo + the main repo's
`docs/developers/development.md` (through the `vendor/notees` checkout).
Commands assume the repo root, Node 22 + pnpm 9 (corepack).

## Commands

```sh
git submodule update --init                 # if cloned without --recurse-submodules
corepack enable && corepack prepare pnpm@9.0.0 --activate
pnpm install                                # setup (CI uses --frozen-lockfile)
pnpm -r --filter "@notees/*" build          # rebuild vendored packages' dists (after a vendor bump)
pnpm build                                  # tsup bundle → dist/cli.js (the `notees` bin)
pnpm typecheck                              # tsc --noEmit
pnpm test                                   # vitest run — the blocking gate
pnpm dev -- --help                          # run the CLI from source via tsx
```

CI-equivalent gate (run before claiming done on anything non-trivial):
`pnpm typecheck && pnpm test`. CI itself (`.github/workflows/ci.yml`)
additionally runs `pnpm -r --workspace-concurrency=1 build` on every push/PR.

**Dev-condition exports:** vitest resolves `src`, tsc resolves `dist`. After
a vendor bump, rebuild the vendored packages' dists first, then typecheck and
test.

## The submodule lockstep law (blocking)

The `vendor/notees` pin is the lockstep boundary with the main repo:

- **Never edit anything under `vendor/`** — it is a pinned snapshot of the
  main repo. A fix lands in the main repo, then arrives here as a pin bump.
- **Only bump forward past the main repo's convergence gate.** A wire
  change / new op / strict payload change is not done in the main repo until
  its fixture gate converges — byte-identical fixture files in
  `packages/protocol/fixtures/`, sha256-checked across the TS reference, GTK,
  and Flutter appliers. Never edit fixture bytes anywhere.
- **Bump recipe** (from README "Syncing the vendored packages"):

  ```sh
  cd vendor/notees && git fetch origin && git checkout origin/main && cd ../..
  pnpm install
  pnpm -r --filter "@notees/*" build   # rebuild the vendored dists
  pnpm build && pnpm test
  ```

  Commit the submodule bump; CI installs with `--frozen-lockfile`, so run
  `pnpm install` once locally to refresh `pnpm-lock.yaml` and commit that
  too.

## Test-suite shape

- One file, `test/cli.test.ts`; `vitest.config.ts` includes only
  `test/**/*.test.ts` so the vendored packages' own suites never leak into
  this run.
- The suite boots a **real** server (`buildServer` from `@notees/server`) on
  an ephemeral port with a temp workspace — no mocks of the object API. One
  server per file (per-test boots accumulated handles and flaked; generous
  30 s hooks are a bounded safety margin).
- Tests drive the CLI through `run()` with a captured `CliIo` (stdout/stderr
  captured, exit code asserted) — plus a few direct `ApiClient` calls where
  the CLI has no write path.
- Test data ids/names are arbitrary strings (`t1-cli-page-v2`, `expm-fp-a`);
  they are data, not version labels — do not "scrub" them.

## Coding conventions

- TypeScript ESM (`"type": "module"`, `.js` import specifiers), strict tsconfig.
- Commander program built in `buildProgram()` (`src/cli.ts`); every command
  action resolves its `CommandContext` via `ctxOf(command)`.
- Output goes through `emit(ctx, humanText, machine)` — `--json` prints the
  machine object; human text is free to change.
- Errors: throw `CliError` with an `EXIT` code (`src/exit-codes.ts`: 0 ok,
  1 domain, 2 usage, 3 auth, 4 conflict, 5 network). Fetch-level failures
  are exit 5; wire errors map via `exitCodeForWireError`.
- No client-side credential-shape checks — the credential is sent verbatim;
  only the server's 401 maps to exit 3.
- System ids (class/property UUIDs, date-chain ids) come from
  `@notees/domain` (`SYSTEM_CLASS_UUIDS`, `SYSTEM_PROPERTY_UUIDS`) — never
  re-hardcode a second copy.
- Dates are local-midnight (`todayIsoLocal`), never UTC.
