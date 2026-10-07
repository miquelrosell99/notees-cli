import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  minify: true,
  // The release bundle must run standalone — scripts/install.sh ships
  // dist/cli.js (as cli.mjs) with no node_modules beside it. tsup keeps
  // `dependencies` external by default; compile every runtime dependency
  // in: the @notees/* workspace packages and commander.
  noExternal: [/^@notees\//, "commander"],
  // commander ships its CommonJS entry to the bundler; the ESM bundle then
  // needs a real `require` for Node builtins. A global createRequire shim
  // (after the shebang — esbuild keeps the #! line first) replaces esbuild's
  // "Dynamic require … is not supported" stub.
  banner: {
    js: [
      'import { createRequire } from "node:module";',
      'if (typeof globalThis.require === "undefined") globalThis.require = createRequire(import.meta.url);',
    ].join("\n"),
  },
});
