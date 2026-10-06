# Changelog

The record of shipped work for the Notees CLI. One entry per shipped slice,
newest first. This file — not `AGENTS.md`, not the README — is where history
goes; those stay static guidance. Before implementing a change, skim this
file for recent related work. Anything before 2026-10-06 lives in git
history.

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
