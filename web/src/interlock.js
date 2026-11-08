// Top-down structure of a recipe set, the way one works it by hand.
//
// Items are either *free* (soft floors and targets: their excess is net
// output, so their producer is a knob) or *zero-net* (fluids and pure
// intermediates). Each zero-net item normally has a designated producer: the
// active recipe whose primary product it is. Working top-down, that producer
// is fixed by its consumers:
//     x_producer = ( sum_consumers use_c x_c  -  sum_other producers make_p x_p ) / yield
// Those are the *links*. A zero-net item with no designated producer (a
// byproduct such as Dark Matter Residue or Uranium Waste) cannot be balanced
// by choosing one recipe: its balance is a *relation* among recipes already
// set. Recipes joined by relations form *interlocked clusters*.

import { Q, ZERO, ONE, add, sub, mul, div, neg, isZero, toNumber, parseQ, bgcd, blcm, nonDecimalPart, decimalsOf } from "./rational.js";
import { analyze, gridOf } from "./exact.js";
import { lllTransform } from "./snap.js";

export function freeItems(model, scenario) {
  const free = new Set([...Object.keys(scenario.adjustable || {}), ...Object.keys(scenario.exact || {}),
    ...Object.keys((scenario.proportional && scenario.proportional.items) || {}), ...model.resources]);
  return free;
}

// cols: active columns (recipes, generators, extraction) with exact io
export function interlockAnalysis(model, scenario, cols) {
  const free = freeItems(model, scenario);
  // extraction counts as the bottom producer of its resource, in steps of the
  // reference extractor; resources are zero-net here so the links reach the miners
  for (const r of model.resources) free.delete(r);
  free.delete("Desc_Water_C");
  const used = cols.filter((c) => !(c.kind === "extract" && c.resource === "Desc_Water_C"));
  const rows = new Map(); // item -> Map(j -> Q)
  used.forEach((c, j) => {
    for (const [it, v] of c.io) {
      if (free.has(it) || it === "Desc_Water_C") continue;
      if (!rows.has(it)) rows.set(it, new Map());
      rows.get(it).set(j, v);
    }
  });
  // designated producer of each zero-net item
  const designated = new Map();
  used.forEach((c, j) => {
    const prim = c.kind === "extract" ? c.resource : c.kind === "recipe" ? c.primary : null;
    if (prim && rows.has(prim) && !designated.has(prim) && toNumber(rows.get(prim).get(j) || ZERO) > 0) designated.set(prim, j);
  });
  const isDesignated = new Set(designated.values());

  // links
  const links = [];
  for (const [it, j] of designated) {
    const row = rows.get(it);
    const y = row.get(j);
    const terms = [];
    for (const [k, v] of row) if (k !== j) terms.push({ j: k, coef: div(neg(v), y) });
    links.push({ item: it, j, yield: y, terms });
  }

  // depth: 0 for recipes that feed nothing zero-net; producer = 1 + max over consumers
  const depth = new Array(used.length).fill(0);
  for (let pass = 0; pass < used.length; pass++) {
    let changed = false;
    for (const L of links) for (const t of L.terms) {
      if (toNumber(t.coef) > 0 && depth[L.j] < depth[t.j] + 1 && depth[t.j] + 1 < used.length) { depth[L.j] = depth[t.j] + 1; changed = true; }
    }
    if (!changed) break;
  }
  links.sort((a, b) => depth[a.j] - depth[b.j]);

  // relations: eliminate designated producers (deepest first), what remains
  // are equations among knobs
  const items = [...rows.keys()];
  const order = used.map((_, j) => j).sort((a, b) => {
    const da = isDesignated.has(a), db = isDesignated.has(b);
    if (da !== db) return da ? -1 : 1;
    return depth[b] - depth[a];
  });
  const pos = new Map(order.map((j, p) => [j, p]));
  const M = items.map((it) => {
    const r = rows.get(it);
    let L = 1n;
    for (const v of r.values()) L = blcm(L, v.d);
    const out = new Array(order.length).fill(0n);
    for (const [j, v] of r) out[pos.get(j)] = v.n * (L / v.d);
    return out;
  });
  const nDes = order.filter((j) => isDesignated.has(j)).length;
  const { rows: R, pivotOf } = rrefInt(M, order.length);
  const relations = [];
  for (const [c, r] of pivotOf) {
    if (c < nDes) continue;
    const row = R[r];
    let g = 0n;
    for (const v of row) g = bgcd(g, v);
    const terms = [];
    row.forEach((v, p) => { if (v !== 0n) terms.push([order[p], v / g]); });
    if (terms.length > 1) relations.push({ terms });
  }
  // clusters: relations sharing members
  const parent = relations.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  relations.forEach((rel, i) => rel.terms.forEach(([j]) => {
    if (owner.has(j)) parent[find(i)] = find(owner.get(j)); else owner.set(j, i);
  }));
  const groups = new Map();
  relations.forEach((rel, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(rel); });
  const clusters = [...groups.values()].map((rels) => {
    const members = [...new Set(rels.flatMap((r) => r.terms.map(([j]) => j)))];
    // designated producers fixed entirely by members, worth keeping nice too
    const memberSet = new Set(members);
    const dependents = links.filter((L) => !memberSet.has(L.j) && L.terms.length && L.terms.every((t) => memberSet.has(t.j))).map((L) => L.j);
    return { relations: rels, members, dependents };
  });
  return { cols: used, rows, designated, links, depth, relations, clusters, free };
}

function rrefInt(rows, n) {
  const norm = (row) => { let g = 0n; for (const v of row) g = bgcd(g, v); if (g > 1n) for (let k = 0; k < row.length; k++) row[k] /= g; return row; };
  const pivotOf = new Map();
  let r = 0;
  for (let c = 0; c < n && r < rows.length; c++) {
    let pr = -1;
    for (let i = r; i < rows.length; i++) if (rows[i][c] !== 0n) { pr = i; break; }
    if (pr < 0) continue;
    [rows[r], rows[pr]] = [rows[pr], rows[r]];
    const P = rows[r];
    if (P[c] < 0n) for (let k = 0; k < P.length; k++) P[k] = -P[k];
    for (let i = 0; i < rows.length; i++) {
      if (i === r || rows[i][c] === 0n) continue;
      const a = P[c], b = rows[i][c], g = bgcd(a, b);
      for (let k = 0; k < rows[i].length; k++) rows[i][k] = rows[i][k] * (a / g) - P[k] * (b / g);
      norm(rows[i]);
    }
    pivotOf.set(c, r);
    r++;
  }
  return { rows, pivotOf };
}

// What each member of a relation needs, if it is the one adjusted last:
// the rest of the relation must be divisible by its coefficient.
export function absorberCost(rel) {
  return rel.terms.map(([j, w]) => {
    const a = w < 0n ? -w : w;
    return { j, coef: w, hard: nonDecimalPart(a), decimal: a / nonDecimalPart(a) };
  });
}

// Nice joint settings for a cluster: every member and dependent on the grid
// of `decimals` (in percent), all cluster balances exact, near `ref`
// (machine-equivalents per column index). Returns up to `count` settings.
export function niceSettings(IA, cluster, ref, { decimals = 1, count = 12, radius = 2, locked = [], lockedValues = [] } = {}) {
  const js = [...cluster.members, ...cluster.dependents];
  // a sub-problem whose "items" are the cluster's relations and the
  // dependents' link equations, so exactly those balances are imposed
  const io = js.map(() => new Map());
  const at = new Map(js.map((j, i) => [j, i]));
  cluster.relations.forEach((rel, r) => rel.terms.forEach(([j, w]) => io[at.get(j)].set(`rel${r}`, Q(w))));
  for (const dj of cluster.dependents) {
    const L = IA.links.find((l) => l.j === dj);
    io[at.get(dj)].set(`link${dj}`, ONE);
    for (const t of L.terms) io[at.get(t.j)].set(`link${dj}`, neg(t.coef));
  }
  const sub = js.map((j, i) => ({ ...IA.cols[j], io: io[i] }));
  const scen = { proportional: { items: {} }, exact: {}, adjustable: {} };
  const dec = {};
  for (const c of sub) dec[c.id] = decimals;
  const pins = locked.map((j, i) => ({ type: "column", id: IA.cols[j].id, value: `${lockedValues[i].n}/${lockedValues[i].d}` }));
  const S = analyze(sub, scen, pins, dec);
  if (S.contradictions.length) return { settings: [], S, impossible: true };
  if (S.lattice.failure) return { settings: [], S, impossible: true };
  const d = S.lattice.d;
  const refv = js.map((j) => ref[j] || 0);
  const w = refv.map((v) => 1 / Math.max(Math.abs(v), 0.05));
  // lattice points x = K + M u; reduce M (weighted) and enumerate near the
  // least-squares centre
  const prog = S.lattice.prog;
  const Mf = [...Array(d)].map((_, k) => sub.map((c, i) => { const v = prog.get(i).M.get(k); return v ? toNumber(v) : 0; }));
  const Kf = sub.map((c, i) => toNumber(prog.get(i).K));
  const T = lllTransform(Mf.map((col) => col.map((v, i) => v * w[i]))) || Mf.map((_, i) => Mf.map((__, t) => (t === i ? 1 : 0)));
  const B = T.map((tk) => sub.map((c, i) => tk.reduce((s, coef, t) => s + coef * Mf[t][i], 0)));
  // centre by least squares on weighted coordinates (normal equations)
  const G = B.map((bi) => B.map((bj) => bi.reduce((s, v, i) => s + v * bj[i] * w[i] * w[i], 0)));
  const rhs = B.map((bi) => bi.reduce((s, v, i) => s + v * (refv[i] - Kf[i]) * w[i] * w[i], 0));
  const c0 = solveSym(G, rhs).map(Math.round);
  const seen = new Set();
  const cands = [];
  const visit = (coef) => {
    const key = coef.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    const x = Kf.map((k, i) => k + coef.reduce((s, ck, t) => s + ck * B[t][i], 0));
    if (x.some((v) => v < -1e-9)) return;
    const dist = x.reduce((s, v, i) => s + Math.abs(v - refv[i]) * w[i], 0);
    cands.push({ coef, dist });
  };
  const dims = Math.min(d, 9);
  const span = dims > 6 ? 1 : radius;
  const rec = (k, coef) => {
    if (k === dims) { visit(coef.slice()); return; }
    for (let s = -span; s <= span; s++) { coef[k] = c0[k] + s; rec(k + 1, coef); }
  };
  rec(0, c0.slice());
  cands.sort((a, b) => a.dist - b.dist);
  // exact values for the best ones
  const settings = cands.slice(0, count).map(({ coef, dist }) => {
    const u = [...Array(d)].map((_, t) => BigInt(T.reduce((s, tk, k) => s + tk[t] * coef[k], 0)));
    const vals = sub.map((c, i) => {
      let v = prog.get(i).K;
      for (const [k, m] of prog.get(i).M) if (u[k] !== 0n) v = add(v, mul(m, Q(u[k])));
      return v;
    });
    return { values: vals, dist };
  });
  return { settings, js, S };
}

function solveSym(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-15) continue;
    for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let t = i; t <= n; t++) M[k][t] -= f * M[i][t]; }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-15 ? 0 : r[n] / r[i]));
}
