import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
