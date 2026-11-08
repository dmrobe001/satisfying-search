// Orchestration: recipe set + scenario + pins + decimal budgets -> structure,
// explanations and a concrete exact plan.

import { Q, ZERO, parseQ, div, sub, mul, isZero, isInt, cmp, toNumber, qstr, nonDecimalPart, decimalsOf } from "./rational.js";
import { analyze, conflictSet, functionalProgression, meetGrid } from "./exact.js";
import { cloneScenario } from "./scenario.js";

const KIND_ORDER = { extract: 0, generator: 1, recipe: 2 };

// Column order matters only for which columns the elimination leaves free:
// later columns tend to stay free, so recipes (the clocks people care about)
// become the free coordinates and extraction becomes dependent.
export function orderColumns(cols) {
  return cols.slice().sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.name.localeCompare(b.name));
}

// does v lie in  offset + step Z ?
export function inProgression(v, prog) {
  if (isZero(prog.step)) return cmp(v, prog.K) === 0;
  return isInt(div(sub(v, prog.offset), prog.step));
}

// The "levers": every inhomogeneous constraint (exact rate, pin) and, for each,
// the values it could take with everything else as it is.
export function leverInfo(cols, scenario, pins, decimals, S) {
  const out = [];
  const A = S.A;
  // exact rates
  for (const [item, val] of Object.entries(scenario.exact || {})) {
    const sc = cloneScenario(scenario);
    delete sc.exact[item];
    sc.adjustable = { ...sc.adjustable, [item]: { min: "0" } };
    const R = analyze(cols, sc, pins, decimals);
    const row = A.get(item);
    const prog = row && !R.lattice.failure ? functionalProgression(R, row) : null;
    out.push({ type: "exact", item, value: parseQ(val), prog, relaxedFails: !!R.lattice.failure });
  }
  // pins
  pins.forEach((pin, i) => {
    const rest = pins.filter((_, k) => k !== i);
    const R = analyze(cols, scenario, rest, decimals);
    let ell = null;
    if (pin.type === "column") {
      const j = cols.findIndex((c) => c.id === pin.id);
      if (j >= 0) ell = new Map([[j, Q(1n)]]);
    } else if (pin.type === "output") ell = A.get(pin.item) || null;
    else if (pin.type === "scale" && S.ref) {
      const p = parseQ(scenario.proportional.items[S.ref]);
      ell = new Map([...(A.get(S.ref) || [])].map(([j, v]) => [j, div(v, p)]));
    }
    const prog = ell && !R.lattice.failure ? functionalProgression(R, ell) : null;
    out.push({ type: "pin", pin, value: parseQ(pin.value), prog, relaxedFails: !!R.lattice.failure });
  });
  for (const L of out) L.ok = L.prog ? inProgression(L.value, L.prog) : null;
  return out;
}

export function fullAnalysis(cols, scenario, pins, decimals) {
  const t0 = performance.now();
  const S = analyze(cols, scenario, pins, decimals);
  S.ms = performance.now() - t0;
  if (S.lattice.failure) S.conflict = conflictSet(S);
  S.levers = leverInfo(cols, scenario, pins, decimals, S);
  return S;
}

// recipes in a set whose per-minute rates are not finite decimals
export function nonDecimalRates(cols) {
  const out = [];
  for (const c of cols) {
    const bad = [...c.io].filter(([, v]) => nonDecimalPart(v.d) > 1n);
    if (bad.length) out.push({ col: c, bad });
  }
  return out;
}

// split a total of x machine-equivalents over n equal machines with as few
// decimals as possible (display only; machine counts are not modelled)
export function equalSplit(x, maxClock = 1) {
  const xf = toNumber(x);
  if (xf <= 0) return null;
  const n0 = Math.max(1, Math.ceil(xf / maxClock - 1e-12));
  let best = null;
  for (let n = n0; n <= Math.max(n0 + 3, Math.ceil(n0 * 1.25)); n++) {
    const c = div(x, Q(BigInt(n)));
    const dec = decimalsOf(mul(c, Q(100n)));
    if (!best || dec < best.dec) best = { n, clock: c, dec };
    if (dec === 0) break;
  }
  return best;
}

// Derived quantities that are not constrained by equalities: the scale of the
// proportional set and each adjustable output. Their attainable progressions.
export function derivedInfo(scenario, S) {
  const out = [];
  if (!S.lattice.prog) return out;
  if (S.ref && S.A.has(S.ref)) {
    const p = parseQ(scenario.proportional.items[S.ref]);
    const ell = new Map([...S.A.get(S.ref)].map(([j, v]) => [j, div(v, p)]));
    out.push({ type: "scale", ell, prog: functionalProgression(S, ell) });
  }
  for (const item of Object.keys(scenario.adjustable || {})) {
    if (!S.A.has(item)) continue;
    const ell = S.A.get(item);
    out.push({ type: "output", item, ell, prog: functionalProgression(S, ell) });
  }
  return out;
}

// Try banning, one at a time, recipes implicated in a conflict; re-choose and
// re-check. onProgress(i, total, result) is called after each trial.
export async function searchBans(model, scenario, S, { candidateColumns, chooseRecipes, maxTrials = 24, onProgress = () => {}, shouldStop = () => false }) {
  const implicated = new Set();
  for (const j of S.conflict || []) {
    implicated.add(j);
    const cl = S.clusterOf[j];
    if (cl >= 0) for (const m of S.clusters[cl].members) implicated.add(m);
  }
  // recipes touching any item the conflict columns touch
  const items = new Set();
  for (const j of S.conflict || []) for (const it of S.cols[j].io.keys()) items.add(it);
  S.cols.forEach((c, j) => { if ([...c.io.keys()].some((i) => items.has(i))) implicated.add(j); });
  const cands = [...implicated].map((j) => S.cols[j]).filter((c) => c.kind === "recipe").slice(0, maxTrials);
  const results = [];
  for (let i = 0; i < cands.length; i++) {
    if (shouldStop()) break;
    const sc = cloneScenario(scenario);
    sc.banned = [...(sc.banned || []), cands[i].id];
    let res;
    try {
      const cc = candidateColumns(model, sc);
      const ch = await chooseRecipes(cc, sc, { timeLimit: 30 });
      if (!ch.active.length) res = { ban: cands[i], status: ch.status };
      else {
        const cols = orderColumns(cc.filter((c) => ch.x.has(c.id)));
        const R = analyze(cols, sc, [], {});
        res = { ban: cands[i], status: R.lattice.failure ? "no exact plan" : "exact lattice exists", feasible: !R.lattice.failure, objective: ch.objective, free: R.free.length };
      }
    } catch (e) {
      res = { ban: cands[i], status: `error: ${e.message}` };
    }
    results.push(res);
    onProgress(i + 1, cands.length, res);
  }
  return results;
}
