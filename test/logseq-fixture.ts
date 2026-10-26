/**
 * The Logseq DB fixture shared by the import-logseq-db specs — a real sqlite
 * file whose kvs rows are transit-encoded with the writer (the same dialect
 * the vendored @notees/export decoder reads, so cache-reference handling is
 * exercised by construction).
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import transit from "transit-js";

// node:sqlite via createRequire: vite's resolver predates the builtin (a
// static `node:sqlite` import fails to transform under vitest).
const requireNode = createRequire(import.meta.url);
const { DatabaseSync } = requireNode("node:sqlite") as typeof import("node:sqlite");

export const E = {
  CLASS_LIBRO: 10,
  CLASS_PERSONA: 11,
  CLASS_QUOTE_SYSTEM: 12,
  CLASS_OBRA: 13,
  PROP_AUTOR: 20,
  PROP_CONSUMIDO: 21,
  PROP_FECHA: 22,
  PROP_SEXO: 23,
  PROP_NIF: 24,
  CLOSED_MUJER: 60,
  CLOSED_HOMBRE: 61,
  PERSONA_NODE: 30,
  PAGE1: 31,
  BLOCK1: 32,
  BLOCK2: 33,
  ORPHAN: 34,
  DAILY: 35,
  NEWER_TITLE: 36,
  OLDER_TITLE: 37,
  OBRA_NODE: 38,
  JOURNAL: 50,
  VIEW_ROOT: 70,
  VIEW_CHILD: 71,
  SYSTEM_DOC_BLOCK: 72,
  ASSET: 80,
} as const;

export const U = {
  libroClass: "aaaaaaaa-0000-4000-8000-000000000010",
  personaClass: "bbbbbbbb-0000-4000-8000-000000000011",
  obraClass: "13131313-0000-4000-8000-000000000013",
  ada: "cccccccc-0000-4000-8000-000000000030",
  page1: "dddddddd-0000-4000-8000-000000000031",
  block1: "eeeeeeee-0000-4000-8000-000000000032",
  block2: "ffffffff-0000-4000-8000-000000000033",
  orphan: "44444444-0000-4000-8000-000000000034",
  daily: "66666666-0000-4000-8000-000000000035",
  newerTitle: "77777777-0000-4000-8000-000000000036",
  olderTitle: "88888888-0000-4000-8000-000000000037",
  obraNode: "99999999-0000-4000-8000-000000000038",
  journal: "55555555-0000-4000-8000-000000000050",
} as const;

export const LQ_UP_NEWER = Date.now() + 5 * 365 * 24 * 3600 * 1000; // strictly newer than anything the server stamps
export const FIXTURE_DAY = "20261025";
export const FIXTURE_DAY_ISO = "2026-10-25";

export type Datom = [number, unknown, unknown, number];

export function buildFixtureFile(dir: string): string {
  const kw = (s: string) => transit.keyword(s);
  const uu = (s: string) => transit.uuid(s);
  const writer = transit.writer("json-verbose");

  const pages: Datom[][] = [
    // user classes: Libro, Persona, Obra (Obra extends Libro target-side)
    [
      [E.CLASS_LIBRO, kw("db/ident"), kw("user.class/libro-aaaa"), 1],
      [E.CLASS_LIBRO, kw("block/title"), "Libro", 1],
      [E.CLASS_LIBRO, kw("block/uuid"), uu(U.libroClass), 1],
    ],
    [
      [E.CLASS_PERSONA, kw("db/ident"), kw("user.class/persona-bbbb"), 1],
      [E.CLASS_PERSONA, kw("block/title"), "Persona", 1],
      [E.CLASS_PERSONA, kw("block/uuid"), uu(U.personaClass), 1],
    ],
    [
      [E.CLASS_OBRA, kw("db/ident"), kw("user.class/obra-cccc"), 1],
      [E.CLASS_OBRA, kw("block/title"), "Obra", 1],
      [E.CLASS_OBRA, kw("block/uuid"), uu(U.obraClass), 1],
    ],
    // a logseq system class — classified system, never a mapped class
    [
      [E.CLASS_QUOTE_SYSTEM, kw("db/ident"), kw("logseq.class/Root"), 1],
      [E.CLASS_QUOTE_SYSTEM, kw("block/title"), "Root Tag", 1],
      [E.CLASS_QUOTE_SYSTEM, kw("block/uuid"), uu("00000002-2737-8382-7000-000000000000"), 1],
    ],
    // properties (the validated mapping-table titles)
    [
      [E.PROP_AUTOR, kw("db/ident"), kw("user.property/autor-dddd"), 1],
      [E.PROP_AUTOR, kw("block/title"), "Autor", 1],
      [E.PROP_AUTOR, kw("logseq.property/type"), kw("node"), 1],
      [E.PROP_AUTOR, kw("db/cardinality"), kw("db.cardinality/many"), 1],
    ],
    [
      [E.PROP_CONSUMIDO, kw("db/ident"), kw("user.property/consumido-eeee"), 1],
      [E.PROP_CONSUMIDO, kw("block/title"), "Consumido", 1],
      [E.PROP_CONSUMIDO, kw("logseq.property/type"), kw("checkbox"), 1],
    ],
    [
      [E.PROP_FECHA, kw("db/ident"), kw("user.property/fecha-ffff"), 1],
      [E.PROP_FECHA, kw("block/title"), "Fecha", 1],
      [E.PROP_FECHA, kw("logseq.property/type"), kw("date"), 1],
    ],
    [
      [E.PROP_SEXO, kw("db/ident"), kw("user.property/sexo-0000"), 1],
      [E.PROP_SEXO, kw("block/title"), "Sexo", 1],
      [E.PROP_SEXO, kw("logseq.property/type"), kw("default"), 1],
    ],
    [
      [E.PROP_NIF, kw("db/ident"), kw("user.property/nif-1111"), 1],
      [E.PROP_NIF, kw("block/title"), "nif", 1],
      [E.PROP_NIF, kw("logseq.property/type"), kw("default"), 1],
    ],
    // closed values backing the Sexo select
    [
      [E.CLOSED_MUJER, kw("block/title"), "Mujer", 1],
      [E.CLOSED_MUJER, kw("block/uuid"), uu("22222222-0000-4000-8000-000000000060"), 1],
      [E.CLOSED_MUJER, kw("block/closed-value-property"), E.PROP_SEXO, 1],
    ],
    [
      [E.CLOSED_HOMBRE, kw("block/title"), "Hombre", 1],
      [E.CLOSED_HOMBRE, kw("block/uuid"), uu("22222222-0000-4000-8000-000000000061"), 1],
      [E.CLOSED_HOMBRE, kw("block/closed-value-property"), E.PROP_SEXO, 1],
    ],
    // the persona node (target of Autor)
    [
      [E.PERSONA_NODE, kw("block/uuid"), uu(U.ada), 1],
      [E.PERSONA_NODE, kw("block/title"), "Ada Lovelace", 1],
      // the Persona tag: the Linked authors filter requires the ref to carry it
      [E.PERSONA_NODE, kw("block/tags"), E.CLASS_PERSONA, 1],
    ],
    // journal day 2026-10-25
    [
      [E.JOURNAL, kw("block/uuid"), uu(U.journal), 1],
      [E.JOURNAL, kw("block/journal-day"), Number(FIXTURE_DAY), 1],
    ],
    // a matched page: every mapped property, same title both sides
    [
      [E.PAGE1, kw("block/uuid"), uu(U.page1), 1],
      [E.PAGE1, kw("block/title"), "Página uno", 1],
      [E.PAGE1, kw("block/tags"), E.CLASS_LIBRO, 1],
      [E.PAGE1, kw("user.property/autor-dddd"), E.PERSONA_NODE, 1],
      [E.PAGE1, kw("user.property/consumido-eeee"), true, 1],
      [E.PAGE1, kw("user.property/fecha-ffff"), E.JOURNAL, 1],
      [E.PAGE1, kw("user.property/sexo-0000"), E.CLOSED_MUJER, 1],
      [E.PAGE1, kw("user.property/nif-1111"), "12345678Z", 1],
    ],
    // blocks under the page — fractional order a0/a1; block2 is Persona-only
    [
      [E.BLOCK1, kw("block/uuid"), uu(U.block1), 1],
      [E.BLOCK1, kw("block/title"), "Primer bloque", 1],
      [E.BLOCK1, kw("block/parent"), E.PAGE1, 1],
      [E.BLOCK1, kw("block/order"), "a0", 1],
      [E.BLOCK1, kw("block/tags"), E.CLASS_LIBRO, 1],
      [E.BLOCK1, kw("block/tags"), E.CLASS_PERSONA, 1],
      [E.BLOCK1, kw("user.property/autor-dddd"), E.PERSONA_NODE, 1],
      [E.BLOCK1, kw("user.property/fecha-ffff"), E.JOURNAL, 1],
    ],
    [
      [E.BLOCK2, kw("block/uuid"), uu(U.block2), 1],
      [E.BLOCK2, kw("block/title"), "Segundo bloque", 1],
      [E.BLOCK2, kw("block/parent"), E.PAGE1, 1],
      [E.BLOCK2, kw("block/order"), "a1", 1],
      [E.BLOCK2, kw("block/tags"), E.CLASS_PERSONA, 1],
      [E.BLOCK2, kw("user.property/fecha-ffff"), E.JOURNAL, 1],
    ],
    // a node whose target row is TRASHED (skipped + reported)
    [
      [E.ORPHAN, kw("block/uuid"), uu(U.orphan), 1],
      [E.ORPHAN, kw("block/title"), "Libro huérfano", 1],
      [E.ORPHAN, kw("block/tags"), E.CLASS_LIBRO, 1],
    ],
    // a node parented at the journal day — lands under the date chain
    [
      [E.DAILY, kw("block/uuid"), uu(U.daily), 1],
      [E.DAILY, kw("block/title"), "Nota diaria", 1],
      [E.DAILY, kw("block/parent"), E.JOURNAL, 1],
      [E.DAILY, kw("block/tags"), E.CLASS_LIBRO, 1],
      [E.DAILY, kw("user.property/nif-1111"), "X123", 1],
    ],
    // title conflicts: newer/older updated-at
    [
      [E.NEWER_TITLE, kw("block/uuid"), uu(U.newerTitle), 1],
      [E.NEWER_TITLE, kw("block/title"), "Título Logseq", 1],
      [E.NEWER_TITLE, kw("block/updated-at"), LQ_UP_NEWER, 1],
      [E.NEWER_TITLE, kw("block/tags"), E.CLASS_LIBRO, 1],
    ],
    [
      [E.OLDER_TITLE, kw("block/uuid"), uu(U.olderTitle), 1],
      [E.OLDER_TITLE, kw("block/title"), "Título viejo Logseq", 1],
      [E.OLDER_TITLE, kw("block/updated-at"), 1, 1],
      [E.OLDER_TITLE, kw("block/tags"), E.CLASS_LIBRO, 1],
    ],
    // a node classed Obra (extends Libro target-side) — extends-aware scope hit
    [
      [E.OBRA_NODE, kw("block/uuid"), uu(U.obraNode), 1],
      [E.OBRA_NODE, kw("block/title"), "Obra hija", 1],
      [E.OBRA_NODE, kw("block/tags"), E.CLASS_OBRA, 1],
      [E.OBRA_NODE, kw("user.property/fecha-ffff"), E.JOURNAL, 1],
    ],
    // $$$views subtree — skipped
    [
      [E.VIEW_ROOT, kw("block/title"), "$$$views", 1],
      [E.VIEW_ROOT, kw("block/uuid"), uu("77777777-0000-4000-8000-000000000070"), 1],
    ],
    [
      [E.VIEW_CHILD, kw("block/title"), "some view config", 1],
      [E.VIEW_CHILD, kw("block/uuid"), uu("77777777-0000-4000-8000-000000000071"), 1],
      [E.VIEW_CHILD, kw("block/parent"), E.VIEW_ROOT, 1],
    ],
    // a built-in doc block under the system class — skipped by ancestry
    [
      [E.SYSTEM_DOC_BLOCK, kw("block/title"), "Provides parent-child relationships between nodes.", 1],
      [E.SYSTEM_DOC_BLOCK, kw("block/uuid"), uu("00000004-6576-4394-8400-000000000072"), 1],
      [E.SYSTEM_DOC_BLOCK, kw("block/parent"), E.CLASS_QUOTE_SYSTEM, 1],
    ],
    // an asset metadata node — counted, not imported
    [
      [E.ASSET, kw("block/uuid"), uu("88888888-0000-4000-8000-000000000080"), 1],
      [E.ASSET, kw("logseq.property.asset/checksum"), "abc123", 1],
    ],
  ];

  const rows: Array<{ addr: number; content: string }> = [
    // addr 0 (schema row) and addr 1 (kv index) must be ignored by the decoder.
    { addr: 0, content: writer.write(transit.map([kw("schema"), transit.map([kw("x"), 1])])) },
    { addr: 1, content: writer.write([[1, kw("kv/value"), 1, 1]]) },
    ...pages.map((datoms, i) => ({
      addr: 1000 + i,
      content: writer.write(transit.map([kw("keys"), datoms])),
    })),
  ];

  const file = join(dir, "logseq-export.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE kvs (addr INTEGER PRIMARY KEY, content TEXT)");
  const insert = db.prepare("INSERT INTO kvs (addr, content) VALUES (?, ?)");
  for (const row of rows) insert.run(row.addr, row.content);
  db.close();
  return file;
}
