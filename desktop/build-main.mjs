import { build } from "esbuild";

await build({
  entryPoints: ["desktop/main.ts"],
  outfile: "dist-desktop/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
});

await build({
  entryPoints: ["desktop/preload.ts"],
  outfile: "dist-desktop/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
});
