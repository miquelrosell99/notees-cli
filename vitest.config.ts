import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The @notees/* packages are vendored workspace projects under
    // vendor/notees — never pick up their suites from this project's run.
    include: ["test/**/*.test.ts"],
  },
});
