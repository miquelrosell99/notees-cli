import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { BUNDLED_LOCALE_XML, BUNDLED_STYLE_XML } from "./styles/generated.js";

export interface StyleEntry {
  id: string;
  label: string;
}

export const BUNDLED_STYLES: readonly StyleEntry[] = [
  { id: "apa", label: "APA (7th edition)" },
  { id: "ieee", label: "IEEE" },
  { id: "chicago-note-bibliography", label: "Chicago (notes & bibliography)" },
];

// Style ids are also file names in --styles-dir — the strict shape blocks
// traversal (resolveStyleXml can never read outside the styles dir).
const STYLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function resolveStyleXml(styleId: string, stylesDir?: string): string | undefined {
  if (!STYLE_ID_PATTERN.test(styleId)) return undefined;
  const bundled = (BUNDLED_STYLE_XML as Record<string, string>)[styleId];
  if (bundled !== undefined) return bundled;
  if (stylesDir !== undefined) {
    const path = join(stylesDir, `${styleId}.csl`);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return undefined;
}

export function listStyles(stylesDir?: string): StyleEntry[] {
  const extra: StyleEntry[] = [];
  if (stylesDir !== undefined && existsSync(stylesDir)) {
    for (const file of readdirSync(stylesDir).sort()) {
      if (!file.endsWith(".csl")) continue;
      const id = file.slice(0, -".csl".length);
      if (!STYLE_ID_PATTERN.test(id) || BUNDLED_STYLES.some((style) => style.id === id)) continue;
      extra.push({ id, label: id });
    }
  }
  return [...BUNDLED_STYLES, ...extra];
}

export function localeXml(lang: string): string | undefined {
  return (BUNDLED_LOCALE_XML as Record<string, string>)[lang];
}
