// From the data model + a scenario to candidate columns, and the recipe-choice
// mixed-integer linear program (MILP) solved by HiGHS.

import { Q, ZERO, parseQ, mul, add, toNumber, isZero } from "./rational.js";
import { solveLP, lpNum } from "./solver.js";

// Candidate columns for a scenario, with exact io (Map item -> Q per unit).
export function candidateColumns(model, scenario) {
  const opt = scenario.options;
  const unit = parseQ(opt.extractionUnit);
  const banned = new Set(scenario.banned || []);
  const infra = infrastructureModel(model, scenario);
  const out = [];
  for (const c of model.columns) {
    if (banned.has(c.id)) continue;
    if (c.kind === "recipe" && opt.excludeConverterToResource && c.converterToResource) continue;
    let io, power;
    if (c.kind === "extract") {
      io = new Map([[c.resource, unit]]);
      power = mul(unit, parseQ(c.powerMWPerUnitRate));
    } else {
      io = new Map(Object.entries(c.io).map(([k, v]) => [k, parseQ(v)]));
      power = parseQ(c.powerMW);
    }
    const bc = c.kind === "extract" ? c.buildCostPerUnitRate : c.buildCost;
    const scaleBC = c.kind === "extract" ? unit : Q(1n);
    const buildCost = new Map(Object.entries(bc || {}).map(([k, v]) => [k, mul(parseQ(v), scaleBC)]));
    // belts, pipes, rails, foundations and power, per machine, then per unit of this column
    const infraCost = new Map();
    if (infra) {
      const perMachine = infra(c);
      const machines = c.kind === "extract" ? mul(parseQ(c.machinesPerUnitRate), unit) : Q(1n);
      for (const [k, v] of perMachine) {
        const t = mul(v, machines);
        infraCost.set(k, t);
        buildCost.set(k, add(buildCost.get(k) || ZERO, t));
      }
    }
    const col = { ...c, io, power, buildCost, infraCost };
    col.lb = scenario.columnMin && scenario.columnMin[c.id] ? parseQ(scenario.columnMin[c.id]) : ZERO;
    col.ub = null;
    if (c.kind === "extract" && c.worldSupply != null) col.ub = divQ(Q(BigInt(c.worldSupply)), unit);
    col.weight = c.kind === "extract" && c.worldSupply ? toNumber(unit) / c.worldSupply : 0;
    out.push(col);
  }
  return out;
}
const divQ = (a, b) => Q(a.n * b.d, a.d * b.n);

// Infrastructure per machine, from the number of item and fluid streams it has:
//   each stream is a belt or pipe of `channelM` metres; belt length is split
//   evenly over the belt tiers, pipe length over the pipe tiers; rail track is
//   `trackFactor` times one belt tier's length; foundations cover the
//   footprint times `foundationFactor`; one power pole (tiers split evenly)
//   and one power line per machine.
export function infrastructureModel(model, scenario) {
  const p = scenario.infrastructure;
  const I = model.infrastructure;
  if (!p || !p.enabled || !I) return null;
  const L = parseQ(p.channelM || "20"), track = parseQ(p.trackFactor || "2"), found = parseQ(p.foundationFactor || "2");
  const addCost = (out, cost, times) => {
    if (isZero(times)) return;
    for (const [k, v] of Object.entries(cost)) out.set(k, add(out.get(k) || ZERO, mul(parseQ(v), times)));
  };
  return (c) => {
    const out = new Map();
    const ch = c.channels || { solid: 0, fluid: 0 };
    const beltLen = mul(L, Q(BigInt(ch.solid)));
    const pipeLen = mul(L, Q(BigInt(ch.fluid)));
    const perBeltTier = divQ(beltLen, Q(BigInt(I.beltTiers.length)));
    for (const t of I.beltTiers) addCost(out, t, perBeltTier);
    for (const t of I.pipeTiers) addCost(out, t, divQ(pipeLen, Q(BigInt(I.pipeTiers.length))));
    addCost(out, I.rail, mul(track, perBeltTier));
    addCost(out, I.foundation, divQ(mul(parseQ(String(c.footprintM2 || 0)), found), Q(BigInt(I.foundationAreaM2))));
    for (const t of I.powerPoles) addCost(out, t, Q(1n, BigInt(I.powerPoles.length)));
    addCost(out, I.powerLine, Q(1n));
    return out;
  };
}

// The scenario as the engines see it: when `buildGunAdjustable` is on, every
// build-gun ingredient not already classified becomes adjustable with min 0.
export function expandScenario(model, scenario) {
  const sc = JSON.parse(JSON.stringify(scenario));
  sc.adjustable = sc.adjustable || {};
  const sr = sc.selfReproduction;
  if (sr && sr.buildGunAdjustable) {
    const taken = new Set([...Object.keys(sc.exact || {}), ...Object.keys(sc.proportional.items || {})]);
    for (const it of model.buildGunItems) {
      if (!taken.has(it) && !(it in sc.adjustable)) sc.adjustable[it] = { min: "0", max: "", auto: true };
    }
  }
  return sc;
}

// 1/T if self-reproduction is on, else null
// Self-replacement runs k times slower than Phase 5: one Phase 5 takes 1/s
// minutes, rebuilding the factory takes k/s, so the rate is s/k.
export function reproRate(scenario) {
  const sr = scenario.selfReproduction;
  if (!sr || !sr.enabled || !sr.ratio) return null;
  const k = parseQ(sr.ratio), sc = parseQ(scenario.proportional.scale || "0");
  if (isZero(k) || isZero(sc)) return null;
  return divQ(sc, k);
}

// Lower-bound row of an adjustable item: sum_j (A_kj - b_jk / T) x_j >= min.
// Returns Map(j -> Q).
export function adjustableLowerRow(cols, A, item, tau) {
  const ell = new Map(A.get(item) || []);
  if (tau) cols.forEach((c, j) => {
    const b = c.buildCost && c.buildCost.get(item);
    if (b) ell.set(j, add(ell.get(j) || ZERO, Q(-(b.n * tau.n), b.d * tau.d)));
  });
  for (const [j, v] of ell) if (isZero(v)) ell.delete(j);
  return ell;
}

export function isGeneratorCounted(col, opt) {
  return col.kind === "generator" && !(opt.exemptNuclearChain && col.nuclearChain);
}

// Power balance as a linear function: sum_j powerCoef_j x_j + constant >= 0
export function powerRow(cols, opt) {
  const boost = parseQ(opt.powerBoost);
  const coef = cols.map((c) => (c.kind === "generator" ? mul(c.power, boost) : c.power)).map((v) => Q(-v.n, v.d));
  const constant = add(parseQ(opt.extraMW), Q(-parseQ(opt.fixedMW).n, parseQ(opt.fixedMW).d));
  return { coef, constant };
}

// Item rows: item -> Map(j -> Q)
export function itemRows(cols) {
  const A = new Map();
  cols.forEach((c, j) => {
    for (const [item, v] of c.io) {
      if (!A.has(item)) A.set(item, new Map());
      A.get(item).set(j, v);
    }
  });
  return A;
}

// The recipe-choice MILP. fixedSet: if given, only those columns, no binaries.
export function choiceLP(cols, scenario, { fixedSet = null, bigM = 5000 } = {}) {
  const opt = scenario.options;
  const use = cols.map((c, j) => (fixedSet ? fixedSet.has(c.id) : true));
  const A = itemRows(cols);
  const name = (j) => `x${j}`;
  const lines = { obj: [], cons: [], bounds: [], bin: [] };
  // objective: abundance-weighted resource use, plus a tiny power tie-break
  const term = (coef, v) => `${coef >= 0 ? "+" : "-"} ${lpNum(Math.abs(coef))} ${v}`;
  const minimax = (scenario.options.objective || "max") === "max";
  cols.forEach((c, j) => {
    if (!use[j]) return;
    // the largest share sets the objective; the sum (scaled down) breaks ties
    const w = (minimax ? 1e-3 : 1) * c.weight + 1e-9 * Math.abs(toNumber(c.power));
    if (w) lines.obj.push(term(w, name(j)));
    if (minimax && c.weight) lines.cons.push(`share${j}: ${term(c.weight, name(j))} - z <= 0`);
  });
  if (minimax) lines.obj.push("+ 1 z");
  const prop = scenario.proportional.items || {};
  const s = parseQ(scenario.proportional.scale || "0");
  const tau = reproRate(scenario);
  let r = 0;
  for (const [item, row] of A) {
    const terms = [];
    for (const [j, v] of row) if (use[j]) terms.push(term(toNumber(v), name(j)));
    if (!terms.length) continue;
    const body = terms.join(" ");
    if (scenario.adjustable && item in scenario.adjustable) {
      const { min, max } = scenario.adjustable[item];
      const lo = adjustableLowerRow(cols, A, item, tau);
      const loTerms = [];
      for (const [j, v] of lo) if (use[j]) loTerms.push(term(toNumber(v), name(j)));
      lines.cons.push(`r${r++}: ${loTerms.join(" ") || "0 x0"} >= ${lpNum(toNumber(parseQ(min || "0")))}`);
      if (max !== undefined && max !== null && max !== "") lines.cons.push(`r${r++}: ${body} <= ${lpNum(toNumber(parseQ(max)))}`);
    } else if (item in prop) {
      lines.cons.push(`r${r++}: ${body} = ${lpNum(toNumber(mul(s, parseQ(prop[item]))))}`);
    } else if (scenario.exact && item in scenario.exact) {
      lines.cons.push(`r${r++}: ${body} = ${lpNum(toNumber(parseQ(scenario.exact[item])))}`);
    } else {
      lines.cons.push(`r${r++}: ${body} = 0`);
    }
  }
  for (const item of [...Object.keys(prop), ...Object.keys(scenario.exact || {})]) {
    if (!A.has(item)) throw new Error(`Nothing available makes ${item}`);
  }
  // power
  const pw = powerRow(cols, opt);
  const pterms = [];
  cols.forEach((c, j) => { if (use[j] && !isZero(pw.coef[j])) pterms.push(term(toNumber(pw.coef[j]), name(j))); });
  lines.cons.push(`power: ${pterms.join(" ")} >= ${lpNum(-toNumber(pw.constant))}`);
  // bounds
  cols.forEach((c, j) => {
    if (!use[j]) return;
    const lb = toNumber(c.lb);
    if (c.ub) lines.bounds.push(`${lpNum(lb)} <= ${name(j)} <= ${lpNum(toNumber(c.ub))}`);
    else if (lb) lines.bounds.push(`${name(j)} >= ${lpNum(lb)}`);
  });
  // binaries
  let groups = [];
  if (!fixedSet) {
    if (opt.noMixing) {
      const byPrimary = new Map();
      cols.forEach((c, j) => {
        if (c.kind !== "recipe") return;
        if (!byPrimary.has(c.primary)) byPrimary.set(c.primary, []);
        byPrimary.get(c.primary).push(j);
      });
      for (const [, js] of byPrimary) if (js.length > 1) groups.push({ js, max: 1 });
    }
    const gens = [];
    cols.forEach((c, j) => { if (isGeneratorCounted(c, opt)) gens.push(j); });
    if (gens.length) groups.push({ js: gens, max: opt.maxOtherGenerators });
    const binOf = new Map();
    groups.forEach((g, gi) => {
      for (const j of g.js) {
        if (!binOf.has(j)) {
          binOf.set(j, `b${j}`);
          lines.bin.push(`b${j}`);
          lines.cons.push(`m${j}: ${name(j)} - ${bigM} b${j} <= 0`);
        }
      }
      lines.cons.push(`g${gi}: ${g.js.map((j) => `+ b${j}`).join(" ")} <= ${g.max}`);
    });
  }
  const lp = [
    "Minimize",
    ` obj: ${wrapLine(lines.obj.join(" ") || "0 x0")}`,
    "Subject To",
    ...lines.cons.map((l) => ` ${wrapLine(l)}`),
    "Bounds",
    ...lines.bounds.map((l) => ` ${l}`),
    ...(lines.bin.length ? ["Binary", ` ${lines.bin.join(" ")}`] : []),
    "End",
  ].join("\n");
  return lp;
}

function wrapLine(l) {
  const t = l.split(" ");
  const out = [];
  for (let i = 0; i < t.length; i += 24) out.push(t.slice(i, i + 24).join(" "));
  return out.join("\n   ");
}

// Choose recipes: MILP, then re-solve as a plain LP on the chosen set.
// Returns { active: [col ids], x: Map(id -> float), objective, status }.
export async function chooseRecipes(cols, scenario, { timeLimit = 60 } = {}) {
  const lp = choiceLP(cols, scenario);
  const r1 = await solveLP(lp, { time_limit: timeLimit, mip_rel_gap: 1e-6, mip_feasibility_tolerance: 1e-9 });
  if (r1.Status !== "Optimal" && !(r1.Status === "Time limit reached" && r1.ObjectiveValue != null)) {
    return { status: r1.Status, active: [], x: new Map() };
  }
  const chosen = new Set();
  cols.forEach((c, j) => {
    const v = r1.Columns[`x${j}`];
    if (v && v.Primal > 1e-7) chosen.add(c.id);
  });
  const lp2 = choiceLP(cols, scenario, { fixedSet: chosen });
  const r2 = await solveLP(lp2, { time_limit: timeLimit });
  if (r2.Status !== "Optimal") return { status: `re-solve: ${r2.Status}`, active: [], x: new Map() };
  const x = new Map();
  cols.forEach((c, j) => {
    const v = r2.Columns[`x${j}`];
    if (v && v.Primal > 1e-9) x.set(c.id, v.Primal);
  });
  return { status: r1.Status, active: [...x.keys()], x, objective: r2.ObjectiveValue, milpObjective: r1.ObjectiveValue };
}

