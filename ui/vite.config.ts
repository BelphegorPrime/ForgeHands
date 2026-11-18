import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/dashboard/ws": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../dist/dashboard", import.meta.url)),
    emptyOutDir: true,
  },
});
