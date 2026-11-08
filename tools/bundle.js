// Bundle the web app into one self-contained HTML file:
//   web/index.html + web/src/*.js (ES modules, concatenated) + build/model.json
//   + the HiGHS solver (JavaScript + WebAssembly, base64) -> dist/satisfying-search.html
// Usage: node tools/bundle.js

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

// dependency order
const modules = ["rational", "lattice", "exact", "solver", "scenario", "model", "snap", "plan", "app"];
let code = "";
for (const m of modules) {
  let src = read(`web/src/${m}.js`);
  src = src.replace(/^import[\s\S]*?from\s+"[^"]+";[ \t]*\n/gm, "");
  src = src.replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, "");
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`unhandled import/export in ${m}.js`);
  code += `\n// ---- ${m}.js ----\n${src}`;
}

const model = read("build/model.json");
const highsJs = read("node_modules/highs/build/highs.js");
const wasm = readFileSync(new URL("node_modules/highs/build/highs.wasm", root));
const wasmB64 = wasm.toString("base64");

const boot = `
// ---- boot ----
async function bootHighs() {
  const b64 = document.getElementById("highs-wasm").textContent.trim();
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const compiled = await WebAssembly.compile(bin);
  setHighsFactory(() => window.Module({
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(compiled, imports).then((inst) => done(inst, compiled));
      return {};
    },
  }));
}
bootHighs().then(start).catch((e) => {
  const el = document.getElementById("status");
  el.textContent = "Could not start the solver: " + e.message;
  el.className = "status bad";
  console.error(e);
});
`;

const safe = (s) => s.replace(/<\/script/gi, "<\\/script");
let html = read("web/index.html");
html = html.replace("<!--HIGHS-->", () => `<script>${safe(highsJs)}</script>`);
html = html.replace("<!--WASM-->", () => `<script type="application/octet-stream" id="highs-wasm">${wasmB64}</script>`);
html = html.replace("<!--MODEL-->", () => `<script>const MODEL = ${safe(model)};</script>`);
html = html.replace("<!--APP-->", () => `<script>(function () {\n"use strict";\n${safe(code)}\n${boot}\n})();</script>`);

mkdirSync(new URL("dist/", root), { recursive: true });
writeFileSync(new URL("dist/satisfying-search.html", root), html);
const sha = createHash("sha256").update(html).digest("hex");
console.log(`wrote dist/satisfying-search.html (${(html.length / 1e6).toFixed(2)} MB, sha256 ${sha.slice(0, 12)}…)`);
