import { cpSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as dotenv from "dotenv";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

dotenv.config({ path: path.resolve(__dirname, ".env") });

// Expose only vars starting with VITE_
const viteEnv = Object.keys(process.env)
  .filter((k) => k.startsWith("VITE_"))
  .reduce<Record<string, string>>((a, k) => {
    a[k] = process.env[k] ?? "";
    return a;
  }, {});

// Xiaolai (CJK, ~13MB) is not self-hosted: Excalidraw falls back to its CDN for fonts missing here.
const EXCALIDRAW_SKIPPED_FONTS = new Set(["Xiaolai"]);

/**
 * Copies the Excalidraw fonts (used by page drawings) into `public/excalidraw-assets/fonts`, which
 * is served at `window.EXCALIDRAW_ASSET_PATH` (set in app/entry.client.tsx). Runs for dev and build.
 * The copied folder is generated, see .gitignore.
 */
function excalidrawAssets(): Plugin {
  return {
    name: "plane:excalidraw-assets",
    buildStart() {
      try {
        const requireFromWeb = createRequire(path.resolve(__dirname, "package.json"));
        const editorDir = path.dirname(requireFromWeb.resolve("@plane/editor/package.json"));
        const requireFromEditor = createRequire(path.join(editorDir, "package.json"));
        const excalidrawEntry = requireFromEditor.resolve("@excalidraw/excalidraw");
        const fontsDir = path.join(path.dirname(excalidrawEntry), "fonts");
        const targetDir = path.resolve(__dirname, "public/excalidraw-assets/fonts");
        for (const fontFamily of readdirSync(fontsDir)) {
          if (EXCALIDRAW_SKIPPED_FONTS.has(fontFamily)) continue;
          cpSync(path.join(fontsDir, fontFamily), path.join(targetDir, fontFamily), { recursive: true });
        }
      } catch (error) {
        this.warn(`Could not copy the Excalidraw fonts, drawings will load fonts from the CDN: ${String(error)}`);
      }
    },
  };
}

export default defineConfig(() => ({
  define: {
    "process.env": JSON.stringify(viteEnv),
  },
  build: {
    assetsInlineLimit: 0,
  },
  plugins: [excalidrawAssets(), reactRouter(), tsconfigPaths({ projects: [path.resolve(__dirname, "tsconfig.json")] })],
  resolve: {
    alias: {
      // Next.js compatibility shims used within web
      "next/link": path.resolve(__dirname, "app/compat/next/link.tsx"),
      "next/navigation": path.resolve(__dirname, "app/compat/next/navigation.ts"),
      "next/script": path.resolve(__dirname, "app/compat/next/script.tsx"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
  },
  // No SSR-specific overrides needed; alias resolves to ESM build
}));
