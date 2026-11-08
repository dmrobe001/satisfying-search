// Thin wrapper over HiGHS compiled to WebAssembly (the `highs` npm package).
// A fresh solver instance per solve: highs-js is known to misbehave when one
// instance is reused for many solves.

let factory = null;
export function setHighsFactory(f) { factory = f; }

export async function solveLP(lp, options = {}) {
  if (!factory) throw new Error("HiGHS not loaded");
  const highs = await factory();
  return highs.solve(lp, { output_flag: false, ...options });
}

// number for the CPLEX LP format: finite, no "Infinity", compact
export function lpNum(x) {
  if (!Number.isFinite(x)) throw new Error(`non-finite coefficient ${x}`);
  if (x === 0) return "0";
  const s = x.toPrecision(15);
  return s.includes("e") ? s.replace(/\.?0+e/, "e") : s.replace(/\.?0+$/, "");
}
