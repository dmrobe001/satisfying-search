// The exact structure of a fixed recipe set.
//
// Unknowns: x_j for each active column j (machine-equivalents at 100% clock).
// Equalities (all exact rationals):
//   every item not in the adjustable set:   (A x)_i = 0, or = e_i if exact
//   the proportional set:                   (A x)_i * p_ref - (A x)_ref * p_i = 0
//   pins:                                   x_j = v,  scale = v,  output_i = v
// Solving them over the rationals writes every column as
//   x_j = x0_j + sum_f C_jf x_f        (f ranges over the free columns)
// Requiring every column to sit on its grid g_j (10^-(2+decimals) machines)
// turns the free columns into integer coordinates m_f = x_f / g_f and every
// other column into a congruence on m.  The lattice of legal clocks is then
//   m = p + B u,  u in Z^d
// and every column is an affine function of u:  x_j = K_j + sum_k M_jk u_k.
// The set of values column j can take in *some* legal plan (ignoring
// inequalities) is the progression  K_j + gcd_k(M_jk) Z.

import {
  Q, ZERO, ONE, add, sub, mul, div, neg, isZero, isInt, cmp, eq,
  bgcd, blcm, babs, bmod, bmodInverse, gcdQ, modQ, decimalsOf, parseQ, roundQ,
} from "./rational.js";
import { AffineLattice } from "./lattice.js";

export const gridOf = (decimals) => Q(1n, 10n ** BigInt(2 + decimals));

// ---- exact row reduction (fraction free, BigInt) -------------------------

function rowNormalize(row) {
  let g = 0n;
  for (const v of row) if (v !== 0n) { g = bgcd(g, v); if (g === 1n) return row; }
  if (g > 1n) for (let k = 0; k < row.length; k++) if (row[k] !== 0n) row[k] /= g;
  return row;
}

// rows: BigInt arrays of length n + k (n unknowns, k right-hand-side columns).
// Returns { pivotOf: Map(col -> row index), rows } in reduced row echelon form.
function rref(rows, n) {
  const pivotOf = new Map();
  let r = 0;
  for (let c = 0; c < n && r < rows.length; c++) {
    let pr = -1;
    for (let i = r; i < rows.length; i++) if (rows[i][c] !== 0n) { pr = i; break; }
    if (pr < 0) continue;
    [rows[r], rows[pr]] = [rows[pr], rows[r]];
    const P = rows[r];
    if (P[c] < 0n) for (let k = 0; k < P.length; k++) P[k] = -P[k];
    const a = P[c];
    const nzP = [];
    for (let k = 0; k < P.length; k++) if (P[k] !== 0n) nzP.push(k);
    for (let i = 0; i < rows.length; i++) {
      if (i === r) continue;
      const R = rows[i];
      const b = R[c];
      if (b === 0n) continue;
      const g = bgcd(a, b), ag = a / g, bg = b / g;
      if (ag !== 1n) for (let k = 0; k < R.length; k++) if (R[k] !== 0n) R[k] *= ag;
      for (const k of nzP) R[k] -= bg * P[k];
      rowNormalize(R);
    }
    pivotOf.set(c, r);
    r++;
  }
  return { pivotOf, rows, rank: r };
}

// ---- building the equality system ----------------------------------------

// scenario: { proportional: {items: {id: p}}, exact: {id: e}, adjustable: {id: {...}} }
// pins: [{type: "column", id, value}] | {type: "scale", value} | {type: "output", item, value}
export function buildEqualities(cols, scenario, pins) {
  const n = cols.length;
  const colIndex = new Map(cols.map((c, j) => [c.id, j]));
  // A as sparse item -> Map(j -> Q)
  const A = new Map();
  cols.forEach((c, j) => {
    for (const [item, v] of c.io) {
      if (!A.has(item)) A.set(item, new Map());
      A.get(item).set(j, v);
    }
  });
  const exact = scenario.exact || {};
  const prop = (scenario.proportional && scenario.proportional.items) || {};
  const adjustable = scenario.adjustable || {};
  const propItems = Object.keys(prop);
  const ref = propItems[0];

  const eqs = []; // {coef: Map(j->Q), rhs: Q, label}
  const problems = [];
  for (const [item, row] of A) {
    if (item in adjustable || item in prop) continue;
    if (item in exact) eqs.push({ coef: row, rhs: parseQ(exact[item]), label: { type: "exact", item } });
    else eqs.push({ coef: row, rhs: ZERO, label: { type: "balance", item } });
  }
  for (const item of Object.keys(exact)) {
    if (!A.has(item) && !isZero(parseQ(exact[item])))
      problems.push(`No active recipe makes ${item}, but it has an exact rate.`);
  }
  if (propItems.length) {
    const pref = parseQ(prop[ref]);
    const rowRef = A.get(ref) || new Map();
    for (const item of propItems.slice(1)) {
      const pi = parseQ(prop[item]);
      const coef = new Map();
      for (const [j, v] of A.get(item) || []) coef.set(j, mul(v, pref));
      for (const [j, v] of rowRef) coef.set(j, sub(coef.get(j) || ZERO, mul(v, pi)));
      eqs.push({ coef, rhs: ZERO, label: { type: "ratio", item, ref } });
    }
  }
  for (const pin of pins) {
    const v = parseQ(pin.value);
    if (pin.type === "column") {
      if (!colIndex.has(pin.id)) continue;
      eqs.push({ coef: new Map([[colIndex.get(pin.id), ONE]]), rhs: v, label: { type: "pin", pin } });
    } else if (pin.type === "scale" && ref) {
      eqs.push({ coef: A.get(ref) || new Map(), rhs: mul(v, parseQ(prop[ref])), label: { type: "pin", pin } });
    } else if (pin.type === "output") {
      eqs.push({ coef: A.get(pin.item) || new Map(), rhs: v, label: { type: "pin", pin } });
    }
  }
  return { eqs, A, problems, ref, n };
}

// ---- the structure --------------------------------------------------------

export function analyze(cols, scenario, pins, decimals) {
  const { eqs, A, problems, ref, n } = buildEqualities(cols, scenario, pins);
  // inhomogeneous rows each get their own right-hand-side column (provenance)
  const sources = [];
  eqs.forEach((e, i) => { if (!isZero(e.rhs)) { e.src = sources.length; sources.push(e.label); } });
  const k = sources.length;
  const rows = eqs.map((e) => {
    let L = 1n;
    for (const v of e.coef.values()) L = blcm(L, v.d);
    L = blcm(L, e.rhs.d);
    const row = new Array(n + k).fill(0n);
    for (const [j, v] of e.coef) row[j] = v.n * (L / v.d);
    if (e.src !== undefined) row[n + e.src] = e.rhs.n * (L / e.rhs.d);
    return rowNormalize(row);
  });
  const { pivotOf, rows: R, rank } = rref(rows, n);

  // contradictions: a zero row with a nonzero right-hand side
  const contradictions = [];
  for (let i = rank; i < R.length; i++) {
    const involved = [];
    for (let s = 0; s < k; s++) if (R[i][n + s] !== 0n) involved.push(sources[s]);
    if (involved.length) contradictions.push(involved);
  }

  const free = [];
  for (let j = 0; j < n; j++) if (!pivotOf.has(j)) free.push(j);
  const freePos = new Map(free.map((j, i) => [j, i]));

  // x_j = sum_s contrib_js + sum_f coef_jf x_f
  const param = new Array(n);
  for (let j = 0; j < n; j++) {
    if (freePos.has(j)) {
      param[j] = { x0: ZERO, contrib: new Map(), coef: new Map([[freePos.get(j), ONE]]) };
      continue;
    }
    const row = R[pivotOf.get(j)];
    const a = row[j];
    const coef = new Map(), contrib = new Map();
    let x0 = ZERO;
    for (const f of free) if (row[f] !== 0n) coef.set(freePos.get(f), Q(-row[f], a));
    for (let s = 0; s < k; s++) if (row[n + s] !== 0n) {
      const v = Q(row[n + s], a);
      contrib.set(s, v);
      x0 = add(x0, v);
    }
    param[j] = { x0, contrib, coef };
  }

  // rigid clusters: columns whose free-parameter rows are proportional
  const clusterOf = new Array(n).fill(-1);
  const clusters = [];
  const byKey = new Map();
  for (let j = 0; j < n; j++) {
    const { coef } = param[j];
    if (coef.size === 0) continue; // fixed column
    const keys = [...coef.keys()].sort((a, b) => a - b);
    const lead = coef.get(keys[0]);
    const key = keys.map((f) => `${f}:${(() => { const r = div(coef.get(f), lead); return `${r.n}/${r.d}`; })()}`).join(",");
    if (!byKey.has(key)) {
      byKey.set(key, clusters.length);
      clusters.push({ members: [], lead: j, dir: keys.map((f) => [f, div(coef.get(f), lead)]) });
    }
    const c = byKey.get(key);
    clusterOf[j] = c;
    clusters[c].members.push(j);
  }
  // inside a cluster: x_j = alpha_j * x_lead + beta_j  (exact)
  for (const cl of clusters) {
    const L = param[cl.lead];
    const f0 = cl.dir[0][0];
    cl.rel = new Map();
    for (const j of cl.members) {
      const P = param[j];
      const alpha = div(P.coef.get(f0), L.coef.get(f0));
      const beta = sub(P.x0, mul(alpha, L.x0));
      cl.rel.set(j, { alpha, beta });
    }
  }

  const result = {
    cols, n, free, freePos, param, clusters, clusterOf, sources, contradictions,
    problems, ref, A, rank, eqCount: eqs.length,
  };
  result.lattice = buildLattice(result, decimals);
  return result;
}

// ---- the lattice of legal clocks ------------------------------------------

export function buildLattice(S, decimals) {
  const { n, free, param, cols } = S;
  const d = free.length;
  const grid = cols.map((c) => gridOf(decimals[c.id] ?? 4));
  // conditions: every non-free column on its grid
  const order = [];
  for (let j = 0; j < n; j++) if (!S.freePos.has(j)) order.push(j);
  // fixed columns first: their failures are the easiest to explain
  order.sort((a, b) => param[a].coef.size - param[b].coef.size);
  const conds = [];
  for (const j of order) {
    const P = param[j];
    const gj = grid[j];
    // x_j / g_j = x0/g_j + sum_f coef_f * g_f / g_j * m_f   must be an integer
    const b = div(P.x0, gj);
    let D = b.d;
    const terms = [];
    for (const [f, c] of P.coef) {
      const t = div(mul(c, grid[free[f]]), gj);
      terms.push([f, t]);
      D = blcm(D, t.d);
    }
    if (D === 1n) continue;
    const a = new Array(d).fill(0n);
    for (const [f, t] of terms) a[f] = bmod(t.n * (D / t.d), D);
    conds.push({ j, a, beta: bmod(b.n * (D / b.d), D), D });
  }
  const L = new AffineLattice(d);
  let failure = null;
  for (let i = 0; i < conds.length; i++) {
    const before = L.clone();
    if (!L.addCondition(conds[i].a, conds[i].beta, conds[i].D)) {
      failure = { column: conds[i].j, before, index: i };
      break;
    }
  }
  const lat = { L, grid, failure, d, conds };
  if (failure) {
    failure.progression = progressionsFor(S, lat, failure.before, [failure.column]).get(failure.column);
    return lat;
  }
  lat.prog = progressionsFor(S, lat, L);
  return lat;
}

function feasible(d, conds) {
  const L = new AffineLattice(d);
  for (const c of conds) if (!L.addCondition(c.a, c.beta, c.D)) return false;
  return true;
}

// A small set of columns whose grid conditions already contradict each other
// (deletion filter in shrinking chunks).  Returns column indices.
export function conflictSet(S) {
  const lat = S.lattice;
  if (!lat.failure) return [];
  let set = lat.conds.slice(0, lat.failure.index + 1);
  let chunk = Math.max(1, Math.ceil((set.length - 1) / 2));
  while (chunk >= 1) {
    let i = 0;
    while (i < set.length - 1) {
      const trial = set.slice(0, i).concat(set.slice(Math.min(i + chunk, set.length - 1)));
      if (trial.length < set.length && !feasible(lat.d, trial)) set = trial;
      else i += chunk;
    }
    if (chunk === 1) break;
    chunk = Math.floor(chunk / 2);
  }
  const cols = new Set(set.map((c) => c.j));
  // every free coordinate the conditions mention, including those whose
  // coefficient vanished modulo D: their integrality is still being used
  for (const c of set) for (const f of S.param[c.j].coef.keys()) cols.add(S.free[f]);
  return [...cols];
}

// progression of a linear functional  sum_j ell_j x_j  over the lattice
export function functionalProgression(S, ell) {
  const prog = S.lattice.prog;
  if (!prog) return null;
  let K = ZERO;
  const M = new Map();
  for (const [j, w] of ell) {
    const p = prog.get(j);
    K = add(K, mul(w, p.K));
    for (const [k, v] of p.M) {
      const t = mul(w, v);
      M.set(k, M.has(k) ? add(M.get(k), t) : t);
    }
  }
  for (const [k, v] of M) if (isZero(v)) M.delete(k);
  const step = gcdQ([...M.values()]);
  return { K, M, step, offset: isZero(step) ? K : modQ(K, step) };
}

// x_j = K_j + sum_k M_jk u_k   for the given lattice; progression step = gcd(M_j)
export function progressionsFor(S, lat, L, only = null) {
  const { param, free, n } = S;
  const { grid } = lat;
  const d = free.length;
  // m_f = p_f + sum_k B_fk u_k ; x_free = g * m
  const rows = [];
  for (let f = 0; f < d; f++) rows.push(L.row(f));
  const out = new Map();
  const targets = only || [...Array(n).keys()];
  for (const j of targets) {
    const P = param[j];
    let K = P.x0;
    const M = new Map();
    for (const [f, c] of P.coef) {
      const cg = mul(c, grid[free[f]]);
      K = add(K, mul(cg, Q(L.p[f])));
      for (const [k, b] of rows[f]) {
        const v = mul(cg, Q(b));
        M.set(k, M.has(k) ? add(M.get(k), v) : v);
      }
    }
    for (const [k, v] of M) if (isZero(v)) M.delete(k);
    const step = gcdQ([...M.values()]);
    out.set(j, { K, M, step, offset: isZero(step) ? K : modQ(K, step) });
  }
  return out;
}

// values  o + step*Z  that are also multiples of h; null if none
export function meetGrid(o, step, h) {
  if (isZero(step)) return isInt(div(o, h)) ? { o, step } : null;
  const A0 = div(o, h), B0 = div(step, h);
  const Lc = blcm(A0.d, B0.d);
  const a = A0.n * (Lc / A0.d), b = B0.n * (Lc / B0.d);
  const g = bgcd(b, Lc);
  if (bmod(a, g) !== 0n) return null;
  const mod = Lc / g;
  let k0 = 0n;
  if (mod !== 1n) {
    const bb = bmod(b / g, mod);
    // modular inverse
    let [r0, r1, s0, s1] = [bb, mod, 1n, 0n];
    while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
    k0 = bmod((-a / g) * s0, mod);
  }
  const newStep = mul(step, Q(mod));
  return { o: modQ(add(o, mul(step, Q(k0))), newStep), step: newStep };
}

// fewest decimals (in percent) any legal value of column j can have
export function fewestDecimals(prog, maxDecimals = 4) {
  for (let t = 0; t <= maxDecimals; t++) if (meetGrid(prog.offset, prog.step, gridOf(t))) return t;
  return Infinity;
}

// Nice values within a relative window of `current`, fewest decimals first:
// [{value, decimals}].  `current` itself is left out.
export function niceValuesNear(prog, current, maxDecimals, { window = Q(3n, 20n), lo = ZERO, count = 3 } = {}) {
  const out = [];
  const seen = new Set([`${current.n}/${current.d}`]);
  const radius = mul(abs2(current), window);
  for (let t = 0; t <= maxDecimals && out.length < count; t++) {
    const m = meetGrid(prog.offset, prog.step, gridOf(t));
    if (!m) continue;
    let cands;
    if (isZero(m.step)) cands = [m.o];
    else {
      const k = roundQ(div(sub(current, m.o), m.step));
      cands = [k - 1n, k, k + 1n].map((kk) => add(m.o, mul(m.step, Q(kk))));
    }
    cands = cands.filter((v) => cmp(v, lo) > 0 && cmp(abs2(sub(v, current)), radius) <= 0)
      .sort((a, b) => cmp(abs2(sub(a, current)), abs2(sub(b, current))));
    for (const v of cands.slice(0, 2)) {
      const key = `${v.n}/${v.d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: v, decimals: decimalsOf(mul(v, Q(100n))) });
      if (out.length >= count) break;
    }
  }
  return out;
}

// fewest decimals among attainable values within the window around `current`
export function fewestDecimalsNear(prog, current, maxDecimals, window = Q(3n, 20n)) {
  if (isZero(prog.step)) return decimalsOf(mul(prog.K, Q(100n)));
  const radius = mul(abs2(current), window);
  for (let t = 0; t <= maxDecimals; t++) {
    const m = meetGrid(prog.offset, prog.step, gridOf(t));
    if (!m) continue;
    const k = roundQ(div(sub(current, m.o), m.step));
    for (const kk of [k - 1n, k, k + 1n]) {
      const v = add(m.o, mul(m.step, Q(kk)));
      if (cmp(abs2(sub(v, current)), radius) <= 0) return t;
    }
  }
  return decimalsOf(mul(current, Q(100n)));
}
const abs2 = (a) => (a.n < 0n ? neg(a) : a);

// evaluate all columns at lattice coordinates u (BigInt[])
export function pointAt(S, u) {
  const { L, prog } = S.lattice;
  const x = new Array(S.n);
  for (let j = 0; j < S.n; j++) {
    const { K, M } = prog.get(j);
    let v = K;
    for (const [k, c] of M) if (u[k] !== 0n) v = add(v, mul(c, Q(u[k])));
    x[j] = v;
  }
  return x;
}

// Why a set of columns cannot all sit on their grids: the exact linear
// relations the balances force among them (everything else eliminated).
// Returns [{ terms: [[j, w (BigInt)]], constant: Q, unit: Q }] where
//   sum_j w_j x_j = constant    holds in every exact plan, and
//   with x_j on its grid the left side is always a multiple of `unit`.
export function relationsAmong(S, colsSubset) {
  const { param, free } = S;
  // fixed columns are constants: they go to the right-hand side
  const C = colsSubset.filter((j) => param[j].coef.size > 0);
  const d = free.length;
  // rows: free coordinates f, columns: members of C  ->  find w with M w = 0
  const rows = [];
  for (let f = 0; f < d; f++) {
    const r = C.map((j) => param[j].coef.get(f) || ZERO);
    if (r.some((v) => !isZero(v))) rows.push(r);
  }
  const k = C.length;
  // integer rows
  const R = rows.map((r) => {
    let L = 1n;
    for (const v of r) L = blcm(L, v.d);
    return rowNormalize(r.map((v) => v.n * (L / v.d)));
  });
  const { pivotOf } = rref(R, k);
  const nonPivot = [];
  for (let c = 0; c < k; c++) if (!pivotOf.has(c)) nonPivot.push(c);
  const out = [];
  for (const c of nonPivot) {
    // w_c = 1 (scaled), w_p = -R[row][c] / R[row][p]
    let w = new Array(k).fill(ZERO);
    w[c] = ONE;
    for (const [p, r] of pivotOf) if (R[r][c] !== 0n) w[p] = Q(-R[r][c], R[r][p]);
    let L = 1n;
    for (const v of w) L = blcm(L, v.d);
    let ints = w.map((v) => v.n * (L / v.d));
    let g = 0n;
    for (const v of ints) g = bgcd(g, v);
    ints = ints.map((v) => v / g);
    const terms = [];
    let constant = ZERO;
    const units = [];
    ints.forEach((wi, i) => {
      if (wi === 0n) return;
      const j = C[i];
      terms.push([j, wi]);
      constant = add(constant, mul(Q(wi), param[j].x0));
      units.push(mul(Q(wi), S.lattice.grid[j]));
    });
    out.push({ terms, constant, unit: gcdQ(units) });
  }
  return out;
}

// Joint contradiction of integer relations, located modulo a small prime p:
// with every column on its grid (x_j = g_j k_j), solve the relations over Z/p.
// Returns { p, pivot, residues: [[j, required residue of k_j mod p, relation index]] }
// for the first prime where they are unsolvable, or null.
export function primeObstruction(S, rels) {
  const grid = S.lattice.grid;
  const primes = [3, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 2, 5];
  for (const p of primes) {
    const P = BigInt(p);
    // rows: coefficients w_j * g_j / u (integers after scaling) and constant / u
    const rows = rels.map((r) => {
      const terms = r.terms.map(([j, w]) => [j, mul(Q(w), grid[j])]);
      let L = r.constant.d;
      for (const [, t] of terms) L = blcm(L, t.d);
      return { a: new Map(terms.map(([j, t]) => [j, bmod(t.n * (L / t.d), P)])), b: bmod(r.constant.n * (L / r.constant.d), P) };
    });
    // Gaussian elimination mod p
    const used = [];
    let bad = null;
    const work = rows.map((r, i) => ({ a: new Map(r.a), b: r.b, i }));
    for (const r of work) {
      for (const u of used) {
        const c = r.a.get(u.j) || 0n;
        if (c === 0n) continue;
        for (const [k, v] of u.a) r.a.set(k, bmod((r.a.get(k) || 0n) - c * v, P));
        r.b = bmod(r.b - c * u.b, P);
      }
      for (const [k, v] of [...r.a]) if (v === 0n) r.a.delete(k);
      if (!r.a.size) { if (r.b !== 0n) { bad = r; break; } continue; }
      const [j, v] = r.a.entries().next().value;
      const inv = bmodInverse(v, P);
      for (const [k, w] of r.a) r.a.set(k, bmod(w * inv, P));
      r.b = bmod(r.b * inv, P);
      used.push({ j, a: r.a, b: r.b, i: r.i });
    }
    if (bad) return { p, rows, used };
  }
  return null;
}
