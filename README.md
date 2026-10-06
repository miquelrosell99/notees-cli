# Notees CLI

The `notees` command-line client for [Notees](https://github.com/miquelrosell99/notees) — the object/property/search surface over the server's public API. Split out of the main monorepo (`apps/cli`) to live alongside the other first-class clients ([GTK](https://github.com/miquelrosell99/notees-gtk), [Flutter](https://github.com/miquelrosell99/notees-flutter)).

The CLI talks to a running `notees-sync` server over HTTP. It holds no state of its own beyond a session credential.

## Layout

```
notees-cli/
├── src/                 # the CLI (commander; `notees` bin)
├── test/                # vitest suite (boots a real server from @notees/server)
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
pnpm test         # vitest (77 tests)
pnpm dev -- --help    # run from source via tsx
```

If you cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

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

`CLI_VERSION` (in `src/cli.ts`) rides the server's release train — the `doctor` command warns when the server is ahead of the CLI. There is no separate npm/docker distribution; install from source.
