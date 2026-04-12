/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const phaserCustomEntry = fileURLToPath(
  new URL('./experiments/phaser-custom/entry.mjs', import.meta.url),
);
const spectorStub = fileURLToPath(
  new URL('./experiments/phaser-custom/phaser3spectorjs-stub.cjs', import.meta.url),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^phaser$/,
        replacement: phaserCustomEntry,
      },
      {
        find: /^phaser3spectorjs$/,
        replacement: spectorStub,
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
