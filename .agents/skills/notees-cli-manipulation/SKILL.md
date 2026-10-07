---
name: notees-cli-manipulation
description: Manipulate a live Notees object graph through the notees CLI — class migrations with tag preservation, carrier-block Description values, mention/link blocks, bulk jobs over hundreds of nodes, and the verification sweeps that prove a migration landed. Use when a task says "change the class of", "tag/untag", "move X to be a link in", "update these blocks/nodes", or any batch edit of graph data (not CLI code) in this repo's workspace.
---

# Notees CLI manipulation

Playbook for editing graph **data** through the `notees` client (the
user-scope `notees-cli` skill covers the command surface; this one covers
the manipulation patterns and the model facts that bite). Nothing here edits
the CLI itself — for that, `notees-cli-development`.

## Model facts that shape every manipulation

- **Classes are tags, and the tag is a node.** Class membership is an
  OR-Set (`class assign`/`unassign` are idempotent); the class itself is an
  ordinary node, so it can be *mentioned* like any other node. Moving a tag
  into content = create a block carrying a `mention` of the class node.
- **Title-is-content; rich content lives on parented blocks.** A node's
  title IS its content. Root pages/classes carry **text-only** content —
  rich tokens (`mention`, `external_link`, …) on a parentless create
  **flatten to their text server-side**. To keep a mention/link, create the
  block **under a parent** (`--parent`, or `presentAsMain: false` with a
  parentId).
- **Text property values are carrier-block refs.** What `object get` shows
  as `"value": {"nodeId": "…"}` for a text property (e.g. Description,
  schema `00000000-0000-0000-0000-000000000009`) is a reference to a child
  block holding the actual contentAst. `object property set <id> Description
  '{"nodeId":"…"}'` is the write. Description is `multi: false` — an
  existing Description means **append into its carrier block** (`object
  update <carrierId> --content '<ast>'`), not a second slot.
- **Token shapes:** mention `{"type":"mention","targetNodeId":"<uuid>","text":"<label>"}`,
  external link `{"type":"external_link","href":"https://…","text":"…"}`,
  plain text `{"type":"text","text":"…"}`.
- **`--json` output is the contract** (additive-only). Drive scripts off it;
  human tables may change.

## The class-migration recipe (tag → class + link preserved)

The recurring shape: "retag these blocks, but keep the old tag visible in
their Description."

```bash
# 1. Class swap — scoped, idempotent, one command when the class's members
#    are all in scope:
notees class remap "modelo 3D" "Web link" --parent <collectionId> --yes --jobs 8
#    (or per node: notees class assign <id> "Web link" && notees class unassign <id> <classUuid>)

# 2. New Description (no existing value): carrier block + property ref:
notees object create --parent <nodeId> --content \
  '[{"type":"mention","targetNodeId":"<classUuid>","text":"modelo 3D"}]'
notees object property set <nodeId> Description '{"nodeId":"<carrierId>"}'

# 3. Existing Description (multi: false): append the mention into the
#    carrier block the property already points at:
notees object update <carrierId> --content '<existingAst + [{"type":"text","text":" "},{"type":"mention",...}]>'
```

Key step most migrations miss: **fetch each node's current state first**
(`object get --ids …`) and branch per node — already-converted nodes skip,
nodes with pre-existing content get the append path. Re-runnable beats
fast-once.

## Bulk jobs (100+ nodes)

1. **Prefer first-class bulk:** `class remap --jobs`, `object create
   --batch` (per-parent order preserved), `object upsert` for re-runnable
   scripts.
2. **Shell for the rest:** `notees shell` helpers (`get/create/update/
   setProperty/api`) with a small concurrency pool (8-way) + per-call retry
   + one `console.log(JSON.stringify(rec))` per node as a progress JSONL on
   stdout. Scripts run in a **vm without `require`/`fs`** — inline the id
   list in the generated script, or pass a file: `notees shell job.js`.
   One-off drivers live in `/tmp`, never in the repo.
3. **Membership-count sanity:** `class list` memberCount is the quick
   before/after probe, but it's a projection — verify by re-fetching.

## Verification (the gate for "data changed")

- Re-fetch the full target set (`object get --ids …` or a shell sweep) and
  assert per node: new class present, old class absent, Description set,
  carrier block's contentAst contains the mention.
- Spot-check one node with `object children` to see the carrier block in
  place.
- Remember the graph is **live and shared** — unrelated nodes can change
  mid-migration; scope assertions to your target set, don't diff the world.

## Sharp edges

- **Destructive commands preview-first:** without `--yes` they print the
  blast radius and exit 2; `--dry-run` exits 0. Parse the preview for scoped
  counts before confirming.
- **`class:`/`prop:`/`linked:` in `search` accept uuids** (name-or-uuid) —
  use them when names are ambiguous or absent.
- **`object children` is unpaginated server-side** — window client-side
  (`--offset/--limit/--count/--fields`) so big listings don't flood output.
- **Select/multi_select values are option ids, never labels** (see the
  user-scope skill's value-shapes reference).
- **Never hand-roll `fetch` against the API** in drivers — the CLI sends
  the workspace header correctly; ad-hoc clients 404 outside the default
  workspace.
