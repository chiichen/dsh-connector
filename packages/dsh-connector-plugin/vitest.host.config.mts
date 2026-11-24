import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/client-host.test.ts"],
    server: {
      deps: {
        inline: ["@deepseek-ai/dsh-client-modules"],
      },
    },
  },
});
