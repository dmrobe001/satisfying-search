// Snapping: the legal plan nearest a reference point, subject to the
// inequalities (bounds, adjustable bands, scale band, power).
//
// Every integer vector u is an exact legal plan  x = K + M u  (see exact.js),
// so the integer program below has no equality constraints at all; this is
// the Aardal-Hurkens-Lenstra reformulation, which is what lets a generic
// branch-and-bound solver cope.  The solver works in floating point, but its
// answer is only used to *choose* u; x is then recomputed exactly and every
// inequality re-checked in rational arithmetic.

import { Q, ZERO, add, sub, mul, div, neg, cmp, isZero, toNumber, parseQ } from "./rational.js";
import { pointAt } from "./exact.js";
import { solveLP, lpNum } from "./solver.js";
import { powerRow, reproRate, adjustableLowerRow } from "./model.js";

// linear functionals the inequalities are written in: [{name, ell: Map(j->Q), lo, hi}]
export function inequalityRows(S, scenario) {
  const rows = [];
  const { cols, A } = S;
  cols.forEach((c, j) => {
    rows.push({ name: `${c.name} >= ${c.lb ? toNumber(c.lb) : 0}`, kind: "lb", j, ell: new Map([[j, Q(1n)]]), lo: c.lb || ZERO, hi: null });
    if (c.ub) rows.push({ name: `${c.name} <= world supply`, kind: "ub", j, ell: new Map([[j, Q(1n)]]), lo: null, hi: c.ub });
  });
  const tau = reproRate(scenario);
  for (const [item, band] of Object.entries(scenario.adjustable || {})) {
    const lo = adjustableLowerRow(cols, A, item, tau);
    if (lo.size || !isZero(parseQ(band.min || "0")))
      rows.push({ name: `output of ${item}`, kind: "output", item, ell: lo, lo: parseQ(band.min || "0"), hi: null, repro: !!tau });
    if (band.max !== undefined && band.max !== "" && band.max !== null && A.has(item))
      rows.push({ name: `output of ${item}`, kind: "output", item, ell: A.get(item), lo: null, hi: parseQ(band.max) });
  }
  const prop = scenario.proportional.items || {};
  if (S.ref && A.has(S.ref)) {
    const pref = parseQ(prop[S.ref]);
    const ell = new Map([...A.get(S.ref)].map(([j, v]) => [j, div(v, pref)]));
    const [lo, hi] = scenario.proportional.band || [null, null];
    rows.push({ name: "scale of the proportional set", kind: "scale", ell, lo: lo ? parseQ(lo) : ZERO, hi: hi ? parseQ(hi) : null });
  }
  const pw = powerRow(cols, scenario.options);
  const ell = new Map();
  pw.coef.forEach((v, j) => { if (!isZero(v)) ell.set(j, v); });
  rows.push({ name: "power balance", kind: "power", ell, lo: neg(pw.constant), hi: null });
  return rows;
}

export const evalRow = (row, x) => {
  let v = ZERO;
  for (const [j, w] of row.ell) v = add(v, mul(w, x[j]));
  return v;
};

export function violations(rows, x) {
  const out = [];
  for (const r of rows) {
    const v = evalRow(r, x);
    if (r.lo && cmp(v, r.lo) < 0) out.push({ row: r, value: v, bound: r.lo, side: "below" });
    if (r.hi && cmp(v, r.hi) > 0) out.push({ row: r, value: v, bound: r.hi, side: "above" });
  }
  return out;
}


// LLL (Lenstra-Lenstra-Lovasz) reduction of the columns of a real n x d
// matrix, in floating point. Returns the integer unimodular d x d transform T
// (as Number[][], T[i][k]) with  basis * T  reduced. Only the *choice* of
// coordinates depends on floats; T is integer and checked to be exact.
export function lllTransform(cols, delta = 0.99) {
  const d = cols.length;
  const b = cols.map((c) => Float64Array.from(c));
  const T = [...Array(d)].map((_, i) => { const r = new Array(d).fill(0); r[i] = 1; return r; }); // T[k] = column k of transform
  const dot = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * y[i]; return s; };
  let bs, B, mu;
  const gso = () => {
    bs = []; B = []; mu = [...Array(d)].map(() => new Array(d).fill(0));
    for (let i = 0; i < d; i++) {
      const v = Float64Array.from(b[i]);
      for (let j = 0; j < i; j++) {
        mu[i][j] = B[j] > 0 ? dot(b[i], bs[j]) / B[j] : 0;
        for (let t = 0; t < v.length; t++) v[t] -= mu[i][j] * bs[j][t];
      }
      bs.push(v); B.push(dot(v, v));
    }
  };
  gso();
  let k = 1, iter = 0;
  while (k < d && iter++ < 100000) {
    for (let j = k - 1; j >= 0; j--) {
      const q = Math.round(mu[k][j]);
      if (q !== 0) {
        for (let t = 0; t < b[k].length; t++) b[k][t] -= q * b[j][t];
        for (let t = 0; t < d; t++) T[k][t] -= q * T[j][t];
        gso();
      }
    }
    if (B[k] >= (delta - mu[k][k - 1] ** 2) * B[k - 1]) k++;
    else {
      [b[k], b[k - 1]] = [b[k - 1], b[k]];
      [T[k], T[k - 1]] = [T[k - 1], T[k]];
      gso();
      k = Math.max(k - 1, 1);
    }
  }
  for (const r of T) for (const v of r) if (!Number.isSafeInteger(v)) return null;
  return T;
}

// xref: Float64Array-like per column (or null entries). Returns
// { status, x (exact Q[]), u, violations }
export async function snap(S, scenario, xref, { timeLimit = 10 } = {}) {
  const lat = S.lattice;
  if (lat.failure) return { status: "no exact plan" };
  const d = lat.d;
  const rows = inequalityRows(S, scenario);
  const ref = S.cols.map((c, j) => (xref[j] == null ? 0 : xref[j]));
  // centre: nearest lattice point in the free coordinates
  const target = S.free.map((j) => ref[j] / toNumber(lat.grid[j]));
  const uref = d ? lat.L.nearestCoords(target) : [];
  const x0 = pointAt(S, uref);
  if (d === 0) {
    return { status: "Optimal", x: x0, u: uref, violations: violations(rows, x0) };
  }
  // reduce the coordinates in the objective's metric: columns of W M
  const wts = S.cols.map((c, j) => 1 / Math.max(Math.abs(ref[j]), 0.05));
  const basisCols = [...Array(d)].map((_, k) => S.cols.map((c, j) => {
    const v = lat.prog.get(j).M.get(k);
    return v ? toNumber(v) * wts[j] : 0;
  }));
  const T = lllTransform(basisCols) || [...Array(d)].map((_, i) => [...Array(d)].map((_, t) => (t === i ? 1 : 0)));
  // M' = M T  (exact): column k of the new coordinates is sum_t T[k][t] * old column t
  const Mnew = new Map();
  for (let j = 0; j < S.n; j++) {
    const Mj = lat.prog.get(j).M;
    const out = new Map();
    for (let k = 0; k < d; k++) {
      let s = ZERO;
      for (const [t, v] of Mj) if (T[k][t]) s = add(s, mul(v, Q(BigInt(T[k][t]))));
      if (!isZero(s)) out.set(k, s);
    }
    Mnew.set(j, out);
  }
  // functional  ell.x = ell.x0 + sum_k (ell.M')_k v_k
  const lin = (ell) => {
    let c = ZERO;
    const M = new Map();
    for (const [j, w] of ell) {
      c = add(c, mul(w, x0[j]));
      for (const [k, v] of Mnew.get(j)) {
        const t = mul(w, v);
        M.set(k, M.has(k) ? add(M.get(k), t) : t);
      }
    }
    return { c, M };
  };
  const expr = (M) => {
    const t = [];
    for (const [k, v] of M) if (!isZero(v)) { const f = toNumber(v); t.push(`${f >= 0 ? "+" : "-"} ${lpNum(Math.abs(f))} v${k}`); }
    return t;
  };
  const wrap = (terms) => { const out = []; for (let i = 0; i < terms.length; i += 8) out.push(terms.slice(i, i + 8).join(" ")); return out.join("\n   "); };
  const cons = [];
  const obj = [];
  let r = 0;
  const infeasibleConstant = [];
  for (const row of rows) {
    const { c, M } = lin(row.ell);
    const t = expr(M);
    if (!t.length) {
      if ((row.lo && cmp(c, row.lo) < 0) || (row.hi && cmp(c, row.hi) > 0)) infeasibleConstant.push(row);
      continue;
    }
    // aim slightly inside each bound: the solver's tolerance is about 1e-6,
    // and the plan is then re-checked exactly
    const margin = (b) => (globalThis.SNAP_MARGIN ?? 1e-6) * (1 + Math.abs(toNumber(b)));
    if (row.lo) cons.push(`c${r++}: ${wrap(t)} >= ${lpNum(toNumber(sub(row.lo, c)) + margin(row.lo))}`);
    if (row.hi) cons.push(`c${r++}: ${wrap(t)} <= ${lpNum(toNumber(sub(row.hi, c)) - margin(row.hi))}`);
  }
  if (infeasibleConstant.length) {
    return { status: "infeasible", reason: infeasibleConstant.map((r) => r.name), x: x0, violations: violations(rows, x0) };
  }
  // distance to the reference, relative per column
  const bounds = [];
  S.cols.forEach((col, j) => {
    const M = Mnew.get(j);
    if (!M.size) return;
    const t = [];
    for (const [k, v] of M) {
      // shift to v = u - uref
      if (!isZero(v)) t.push([k, toNumber(v)]);
    }
    const w = wts[j];
    const dev = toNumber(x0[j]) - ref[j];
    const pos = t.map(([k, f]) => `${f >= 0 ? "+" : "-"} ${lpNum(Math.abs(f))} v${k}`);
    const negt = t.map(([k, f]) => `${f >= 0 ? "-" : "+"} ${lpNum(Math.abs(f))} v${k}`);
    cons.push(`p${j}: e${j} ${wrap(negt)} >= ${lpNum(dev)}`);
    cons.push(`n${j}: e${j} ${wrap(pos)} >= ${lpNum(-dev)}`);
    obj.push(`+ ${lpNum(w)} e${j}`);
    bounds.push(` e${j} >= 0`);
  });
  const vars = [...Array(d).keys()].map((k) => `v${k}`);
  const lp = [
    "Minimize",
    ` obj: ${wrap(obj) || "0 v0"}`,
    "Subject To",
    ...cons.map((l) => ` ${l}`),
    "Bounds",
    ...vars.map((v) => ` ${v} free`),
    ...bounds,
    "General",
    ` ${wrap(vars)}`,
    "End",
  ].join("\n");
  let res;
  try {
    res = await solveLP(lp, { time_limit: timeLimit, mip_rel_gap: 1e-2, mip_abs_gap: 1e-3, mip_max_nodes: 20000 });
  } catch (e) {
    return { status: `solver error: ${e.message}`, x: x0, violations: violations(rows, x0) };
  }
  if (!res.Columns || (res.Status !== "Optimal" && res.Status !== "Time limit reached") || res.ObjectiveValue == null) {
    return { status: res.Status === "Infeasible" ? "infeasible" : res.Status, x: x0, violations: violations(rows, x0) };
  }
  const v = [...Array(d)].map((_, k) => BigInt(Math.round(res.Columns[`v${k}`].Primal)));
  const u = uref.map((b, t) => { let s = b; for (let k = 0; k < d; k++) if (T[k][t]) s += BigInt(T[k][t]) * v[k]; return s; });
  const x = pointAt(S, u);
  return { status: res.Status, x, u, violations: violations(rows, x), rows };
}
