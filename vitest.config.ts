import { defineConfig } from "vitest/config";

export default defineConfig({
  // Igual que la regla Text de wrangler.toml: los .html se importan como texto.
  plugins: [
    {
      name: "html-as-text",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith(".html")) return { code: `export default ${JSON.stringify(code)}`, map: null };
      },
    },
  ],
});
