import { copyFile } from "node:fs/promises";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [{
    name: "copy-browser-script",
    apply: "build",
    async writeBundle() {
      await copyFile("app.js", "dist/app.js");
    }
  }],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
