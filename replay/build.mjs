import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outdir = resolve(import.meta.dirname, "dist");

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [resolve(import.meta.dirname, "src/recorder.js")],
  outfile: resolve(outdir, "replay-recorder.js"),
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: false,
  target: ["chrome120", "firefox121", "safari17"],
  legalComments: "none",
  absWorkingDir: root,
});

await build({
  entryPoints: [resolve(import.meta.dirname, "src/viewer.js")],
  outfile: resolve(outdir, "viewer.js"),
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: false,
  target: ["chrome120", "firefox121", "safari17"],
  legalComments: "none",
  absWorkingDir: root,
});
