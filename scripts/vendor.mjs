import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjsSource = resolve(root, "node_modules/pdfjs-dist");
const pdfLibSource = resolve(root, "node_modules/pdf-lib");
const pdfjsTarget = resolve(root, "vendor/pdfjs");
const pdfLibTarget = resolve(root, "vendor/pdf-lib");

await rm(resolve(root, "vendor"), { recursive: true, force: true });
await mkdir(pdfjsTarget, { recursive: true });
await mkdir(pdfLibTarget, { recursive: true });

for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  await cp(resolve(pdfjsSource, "legacy/build", file), resolve(pdfjsTarget, file));
}

for (const directory of ["cmaps", "iccs", "standard_fonts", "wasm"]) {
  await cp(resolve(pdfjsSource, directory), resolve(pdfjsTarget, directory), {
    recursive: true,
  });
}

await cp(resolve(pdfjsSource, "LICENSE"), resolve(pdfjsTarget, "LICENSE"));
await cp(
  resolve(pdfLibSource, "dist/pdf-lib.min.js"),
  resolve(pdfLibTarget, "pdf-lib.min.js"),
);
await cp(
  resolve(pdfLibSource, "LICENSE.md"),
  resolve(pdfLibTarget, "LICENSE.md"),
);

console.log("Dependencias del navegador copiadas en vendor/.");
