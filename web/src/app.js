// Browser UI. Everything exact is computed by the other modules; this file
// only keeps state, calls them, and renders.

import {
  Q, ZERO, parseQ, mul, div, add, sub, cmp, isZero, toNumber, qstr, decimalString, percentString,
  decimalsOf, nonDecimalPart, factorString, roundQ,
} from "./rational.js";
import { DEFAULT_SCENARIO, cloneScenario } from "./scenario.js";
import { candidateColumns, chooseRecipes, isGeneratorCounted, expandScenario, minimizeT, reproRate, adjustableLowerRow } from "./model.js";
import { fewestDecimals, fewestDecimalsNear, niceValuesNear, relationsAmong, gridOf, primeObstruction } from "./exact.js";
import { snap, inequalityRows, evalRow } from "./snap.js";
import { fullAnalysis, orderColumns, derivedInfo, equalSplit, nonDecimalRates, searchBans, inProgression } from "./plan.js";

const STORE = "satisfying-search-v2";
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const itemName = (id) => (MODEL.items[id] ? MODEL.items[id].name : id);
const nameToItem = new Map(Object.entries(MODEL.items).map(([k, v]) => [v.name.toLowerCase(), k]));

const PRESETS = {
  portal: { label: "Phase 5, Portal, Augmenter, equipment, self-reproduction", make: () => cloneScenario(DEFAULT_SCENARIO) },
  loose: {
    label: "Same, with Singularity Cells adjustable in 2–2.001/min",
    make: () => {
      const s = cloneScenario(DEFAULT_SCENARIO);
      delete s.exact.Desc_SingularityCell_C;
      s.adjustable.Desc_SingularityCell_C = { min: "2", max: "2.001" };
      return s;
    },
  },
};

let state = {
  scenario: PRESETS.portal.make(),
  active: null, // [ids] from recipe choice
  choiceX: null, // {id: float}
  objective: null,
  pins: [],
  decimals: {},
  point: null, // {id: "p/q"}
  open: {}, // expanded detail rows
};
let S = null; // current analysis
const XS = () => expandScenario(MODEL, state.scenario); // scenario as the engines see it
let snapResult = null;
let busy = false;
let banSearch = null;

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ ...state, open: {} })); } catch (e) { /* storage unavailable */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null");
    if (s && s.scenario) state = { ...state, ...s, open: {} };
  } catch (e) { /* ignore */ }
}

function setStatus(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = `status ${kind}`;
}

async function withBusy(msg, fn) {
  if (busy) return;
  busy = true;
  document.body.classList.add("busy");
  setStatus(msg, "working");
  await new Promise((r) => setTimeout(r, 20));
  try { await fn(); } catch (e) { console.error(e); setStatus(`Error: ${e.message}`, "bad"); }
  busy = false;
  document.body.classList.remove("busy");
}

// ---------------------------------------------------------------- actions

async function chooseAndAnalyze() {
  await withBusy("Choosing recipes (mixed-integer program)…", async () => {
    const xs = XS();
    const cand = candidateColumns(MODEL, xs);
    const t = performance.now();
    const ch = await chooseRecipes(cand, xs);
    if (!ch.active.length) {
      state.active = null; S = null; snapResult = null;
      setStatus(`Recipe choice: ${ch.status}. Nothing satisfies the scenario; loosen a band or unban something.`, "bad");
      render();
      return;
    }
    state.active = ch.active;
    state.choiceX = Object.fromEntries(ch.x);
    state.objective = ch.objective;
    const ids = new Set(ch.active);
    state.pins = state.pins.filter((p) => p.type !== "column" || ids.has(p.id));
    state.point = null;
    setStatus(`Chose ${ch.active.length} columns in ${((performance.now() - t) / 1000).toFixed(1)} s.`);
    await analyzeAndSnap(true);
  });
}

async function findMinT() {
  await withBusy("Finding the smallest self-reproduction time…", async () => {
    const xs = XS();
    xs.selfReproduction = { ...xs.selfReproduction, enabled: true };
    const res = await minimizeT(candidateColumns(MODEL, xs), xs, { onProgress: (m) => setStatus(m, "working") });
    if (res.status !== "ok") { setStatus(`Smallest T: ${res.status}`, "bad"); return; }
    // round up with 10% headroom to 2 significant figures, so the inequalities keep some slack
    const t = res.T * 1.1;
    const mag = 10 ** Math.floor(Math.log10(t) - 1);
    const T = Math.ceil(t / mag) * mag;
    state.scenario.selfReproduction = { ...state.scenario.selfReproduction, enabled: true, T: String(T) };
    state.minTmsg = `smallest feasible T ≈ ${res.T.toFixed(2)} min; set to ${T} (10% headroom)`;
    save();
    renderScenario();
  });
  await chooseAndAnalyze();
}

function activeColumns() {
  const cand = candidateColumns(MODEL, XS());
  const ids = new Set(state.active || []);
  return orderColumns(cand.filter((c) => ids.has(c.id)));
}

async function analyzeAndSnap(fromChoice = false) {
  const cols = activeColumns();
  const decimals = {};
  for (const c of cols) decimals[c.id] = state.decimals[c.id] ?? state.scenario.decimals ?? 4;
  S = fullAnalysis(cols, XS(), state.pins, decimals);
  S.decimals = decimals;
  snapResult = null;
  if (S.lattice.failure || S.contradictions.length) {
    setStatus("No exact plan exists with this recipe set and these constraints — see the explanation below.", "bad");
  } else {
    const ref = cols.map((c) => {
      if (!fromChoice && state.point && state.point[c.id]) return toNumber(parseQ(state.point[c.id]));
      return state.choiceX ? state.choiceX[c.id] ?? 0 : 0;
    });
    const t = performance.now();
    snapResult = await snap(S, XS(), ref);
    const ms = performance.now() - t;
    if (snapResult.x && snapResult.status !== "infeasible" && !snapResult.violations.length) {
      state.point = Object.fromEntries(cols.map((c, j) => [c.id, qstr(snapResult.x[j])]));
      setStatus(`Exact plan: ${S.free.length} free parameters, ${S.n} columns; structure ${S.ms.toFixed(0)} ms, snap ${ms.toFixed(0)} ms.`, "good");
    } else {
      setStatus("Exact plans exist, but none satisfies every inequality — see the levers below.", "warn");
    }
  }
  save();
  render();
}

function addPin(pin) {
  state.pins = state.pins.filter((p) => !(p.type === pin.type && p.id === pin.id && p.item === pin.item));
  state.pins.push(pin);
  withBusy("Re-solving with the new pin…", () => analyzeAndSnap());
}
function removePin(i) {
  state.pins.splice(i, 1);
  withBusy("Re-solving…", () => analyzeAndSnap());
}
function setBudget(id, d) {
  if (d === "" || d === null) delete state.decimals[id];
  else state.decimals[id] = Number(d);
  withBusy("Re-solving with the new decimal budget…", () => analyzeAndSnap());
}
function ban(id) {
  state.scenario.banned = [...new Set([...(state.scenario.banned || []), id])];
  chooseAndAnalyze();
}

// ---------------------------------------------------------------- formatting

const pct = (x, max = 14) => `${percentString(x, max)}%`;
function rateStr(q) {
  return decimalString(q, 12);
}
function progStr(prog, unitIsPercent = true) {
  if (!prog) return "—";
  if (isZero(prog.step)) return `only ${unitIsPercent ? pct(prog.K) : rateStr(prog.K)}`;
  const st = unitIsPercent ? pct(prog.step) : rateStr(prog.step);
  const off = isZero(prog.offset) ? "" : ` + ${unitIsPercent ? pct(prog.offset) : rateStr(prog.offset)}`;
  return `k × ${st}${off}`;
}
function nearestInProg(prog, v, count = 2) {
  if (!prog || isZero(prog.step)) return prog ? [prog.K] : [];
  const k = roundQ(div(sub(v, prog.offset), prog.step));
  const out = [];
  for (const kk of [k - 1n, k, k + 1n]) out.push(add(prog.offset, mul(prog.step, Q(kk))));
  return out.sort((a, b) => cmp(absq(sub(a, v)), absq(sub(b, v)))).slice(0, count);
}
const absq = (a) => (a.n < 0n ? Q(-a.n, a.d) : a);
function sourceLabel(lbl) {
  if (!lbl) return "?";
  if (lbl.type === "exact") return `exact rate of ${itemName(lbl.item)}`;
  if (lbl.type === "pin") return pinLabel(lbl.pin);
  return lbl.type;
}
function pinLabel(p) {
  if (p.type === "column") {
    const c = MODEL.columns.find((c) => c.id === p.id);
    return `pin: ${c ? c.name.replace(/^Alternate: /, "") : p.id} = ${pct(parseQ(p.value))}`;
  }
  if (p.type === "scale") return `pin: scale = ${decimalString(parseQ(p.value), 12)} sets/min`;
  return `pin: output of ${itemName(p.item)} = ${decimalString(parseQ(p.value), 12)}/min`;
}
function decClass(d) {
  if (d === Infinity) return "dec-bad";
  return `dec-${Math.min(d, 4)}`;
}

// ---------------------------------------------------------------- scenario editor

function renderScenario() {
  const sc = state.scenario;
  const o = sc.options;
  sc.selfReproduction = sc.selfReproduction || { enabled: false, buildGunAdjustable: false, T: "1000" };
  const sr = sc.selfReproduction;
  const itemOptions = Object.entries(MODEL.items).map(([, v]) => `<option value="${esc(v.name)}">`).join("");
  const propRows = Object.entries(sc.proportional.items || {}).map(([id, p]) => `
    <tr><td>${esc(itemName(id))}</td><td><input data-k="prop" data-id="${id}" value="${esc(p)}" size="7"></td>
    <td><button class="x" data-del="prop" data-id="${id}" title="remove">×</button></td></tr>`).join("");
  const exactRows = Object.entries(sc.exact || {}).map(([id, v]) => `
    <tr><td>${esc(itemName(id))}</td><td><input data-k="exact" data-id="${id}" value="${esc(v)}" size="7"> /min</td>
    <td><button class="x" data-del="exact" data-id="${id}" title="remove">×</button></td></tr>`).join("");
  const adjRows = Object.entries(sc.adjustable || {}).map(([id, b]) => `
    <tr><td>${esc(itemName(id))}</td><td><input data-k="adjmin" data-id="${id}" value="${esc(b.min ?? "0")}" size="4"> –
    <input data-k="adjmax" data-id="${id}" value="${esc(b.max ?? "")}" size="4" placeholder="∞"></td>
    <td><button class="x" data-del="adj" data-id="${id}" title="remove">×</button></td></tr>`).join("");
  const banned = (sc.banned || []).map((id) => {
    const c = MODEL.columns.find((c) => c.id === id);
    return `<span class="chip">${esc(c ? c.name : id)} <button class="x" data-unban="${id}">×</button></span>`;
  }).join(" ") || `<span class="muted">none</span>`;
  const mins = Object.entries(sc.columnMin || {}).map(([id, v]) => {
    const c = MODEL.columns.find((c) => c.id === id);
    return `<span class="chip">${esc(c ? c.name : id)} ≥ <input data-k="colmin" data-id="${id}" value="${esc(v)}" size="4"> machines <button class="x" data-delmin="${id}">×</button></span>`;
  }).join(" ") || `<span class="muted">none</span>`;
  $("#scenario").innerHTML = `
    <datalist id="items">${itemOptions}</datalist>
    <div class="preset">Preset:
      ${Object.entries(PRESETS).map(([k, p]) => `<button data-preset="${k}">${esc(p.label)}</button>`).join(" ")}
    </div>
    <div class="grid3">
      <section>
        <h3>Proportional <span class="muted">net output = s × p</span></h3>
        <table class="mini"><tbody>${propRows}</tbody></table>
        <div class="add"><input list="items" placeholder="add item…" data-add="prop"></div>
        <label>target scale s <input data-k="scale" value="${esc(sc.proportional.scale)}" size="8"> sets/min</label>
        <label>band <input data-k="slo" value="${esc(sc.proportional.band[0])}" size="8"> – <input data-k="shi" value="${esc(sc.proportional.band[1])}" size="8"></label>
      </section>
      <section>
        <h3>Exact <span class="muted">net output = e</span></h3>
        <table class="mini"><tbody>${exactRows}</tbody></table>
        <div class="add"><input list="items" placeholder="add item…" data-add="exact"></div>
      </section>
      <section>
        <h3>Adjustable <span class="muted">min ≤ net output ≤ max, /min</span></h3>
        <table class="mini"><tbody>${adjRows}</tbody></table>
        <div class="add"><input list="items" placeholder="add item…" data-add="adj"></div>
        <label><input type="checkbox" data-k="sr:buildGunAdjustable" ${sr.buildGunAdjustable ? "checked" : ""}> also every build-gun ingredient (${MODEL.buildGunItems.length} items, min 0)</label>
        <label><input type="checkbox" data-k="sr:enabled" ${sr.enabled ? "checked" : ""}> self-reproduction: build-gun outputs rebuild the factory's machines in
          <input data-k="sr:T" value="${esc(sr.T)}" size="6"> min</label>
        <div><button id="minT">Find smallest T</button> <span id="minTmsg" class="small muted">${esc(state.minTmsg || "")}</span></div>
      </section>
    </div>
    <p class="muted small">Every other item, raw resources included, must net exactly zero. Values are exact: type <code>2</code>, <code>12.5</code> or <code>25/6</code>.</p>
    <details class="opts"><summary>Options, bans and bounds</summary>
      <div class="optgrid">
        <label>Reference extractor <input data-k="opt:extractionUnit" value="${esc(o.extractionUnit)}" size="5"> /min at 100%</label>
        <label>Default clock decimals <select data-k="decimals">${[0, 1, 2, 3, 4].map((d) => `<option ${d === (sc.decimals ?? 4) ? "selected" : ""}>${d}</option>`).join("")}</select></label>
        <label>Power boost × <input data-k="opt:powerBoost" value="${esc(o.powerBoost)}" size="5"></label>
        <label>Extra generation <input data-k="opt:extraMW" value="${esc(o.extraMW)}" size="5"> MW</label>
        <label>Fixed consumption <input data-k="opt:fixedMW" value="${esc(o.fixedMW)}" size="5"> MW</label>
        <label><input type="checkbox" data-k="opt:noMixing" ${o.noMixing ? "checked" : ""}> one recipe per product</label>
        <label>Max generator recipes outside the nuclear chain <input data-k="opt:maxOtherGenerators" value="${esc(o.maxOtherGenerators)}" size="2"></label>
        <label><input type="checkbox" data-k="opt:exemptNuclearChain" ${o.exemptNuclearChain ? "checked" : ""}> uranium, plutonium and ficsonium rods don't count</label>
        <label><input type="checkbox" data-k="opt:excludeConverterToResource" ${o.excludeConverterToResource ? "checked" : ""}> no Converter recipes for mineable resources</label>
      </div>
      <p><b>Banned:</b> ${banned}</p>
      <p><b>Column minimums:</b> ${mins}</p>
    </details>
    <div class="actions">
      <button class="primary" id="choose">Choose recipes and solve</button>
      <button id="export">Export</button>
      <button id="import">Import</button>
    </div>
    <textarea id="io" class="hidden" rows="8" spellcheck="false"></textarea>`;
}

function onScenarioInput(e) {
  const t = e.target;
  const sc = state.scenario;
  const k = t.dataset.k;
  if (!k) return;
  const id = t.dataset.id;
  const v = t.type === "checkbox" ? t.checked : t.value.trim();
  if (k === "prop") sc.proportional.items[id] = v;
  else if (k === "exact") sc.exact[id] = v;
  else if (k === "adjmin") sc.adjustable[id].min = v;
  else if (k === "adjmax") sc.adjustable[id].max = v;
  else if (k === "scale") sc.proportional.scale = v;
  else if (k === "slo") sc.proportional.band[0] = v;
  else if (k === "shi") sc.proportional.band[1] = v;
  else if (k === "colmin") sc.columnMin[id] = v;
  else if (k === "decimals") sc.decimals = Number(v);
  else if (k.startsWith("sr:")) sc.selfReproduction[k.slice(3)] = v;
  else if (k.startsWith("opt:")) {
    const key = k.slice(4);
    sc.options[key] = key === "maxOtherGenerators" ? Number(v) : v;
  }
  save();
}

function onScenarioClick(e) {
  const t = e.target;
  const sc = state.scenario;
  if (t.dataset.preset) {
    state.scenario = PRESETS[t.dataset.preset].make();
    state.pins = []; state.decimals = {}; state.active = null; state.point = null; S = null; snapResult = null;
    render();
    chooseAndAnalyze();
  } else if (t.dataset.del) {
    const id = t.dataset.id;
    if (t.dataset.del === "prop") delete sc.proportional.items[id];
    if (t.dataset.del === "exact") delete sc.exact[id];
    if (t.dataset.del === "adj") delete sc.adjustable[id];
    save(); renderScenario();
  } else if (t.dataset.unban) {
    sc.banned = sc.banned.filter((x) => x !== t.dataset.unban);
    save(); renderScenario();
  } else if (t.dataset.delmin) {
    delete sc.columnMin[t.dataset.delmin];
    save(); renderScenario();
  } else if (t.id === "choose") chooseAndAnalyze();
  else if (t.id === "minT") findMinT();
  else if (t.id === "export") {
    const io = $("#io");
    io.classList.remove("hidden");
    io.value = JSON.stringify({ about: "satisfying-search plan", model_sha256: MODEL.source.data_sha256, ...state, open: undefined }, null, 1);
    io.select();
  } else if (t.id === "import") {
    const io = $("#io");
    if (io.classList.contains("hidden") || !io.value.trim()) {
      io.classList.remove("hidden");
      io.value = "";
      io.placeholder = "Paste an exported plan here, then press Import again.";
      return;
    }
    try {
      const s = JSON.parse(io.value);
      state = { ...state, ...s, open: {} };
      save(); render();
      if (state.active) withBusy("Re-solving imported plan…", () => analyzeAndSnap());
    } catch (err) { setStatus(`Import failed: ${err.message}`, "bad"); }
  }
}

function onScenarioChange(e) {
  const t = e.target;
  if (t.dataset.add) {
    const id = nameToItem.get(t.value.trim().toLowerCase());
    if (!id) return;
    const sc = state.scenario;
    delete sc.proportional.items[id]; delete sc.exact[id]; delete sc.adjustable[id];
    if (t.dataset.add === "prop") sc.proportional.items[id] = "1";
    if (t.dataset.add === "exact") sc.exact[id] = "1";
    if (t.dataset.add === "adj") sc.adjustable[id] = { min: "1", max: "" };
    save(); renderScenario();
  } else onScenarioInput(e);
}

// ---------------------------------------------------------------- results

function render() {
  renderScenario();
  renderSummary();
  renderLevers();
  renderTable();
  renderWhy();
}

function renderSummary() {
  const el = $("#summary");
  if (!S) { el.innerHTML = `<p class="muted">Press <b>Choose recipes and solve</b>.</p>`; return; }
  const cols = S.cols;
  const x = snapResult && snapResult.x;
  let resUse = 0;
  if (x) cols.forEach((c, j) => { if (c.kind === "extract" && c.worldSupply) resUse += toNumber(mul(x[j], c.io.get(c.resource))) / c.worldSupply; });
  const gens = cols.filter((c) => c.kind === "generator");
  const counted = gens.filter((c) => isGeneratorCounted(c, state.scenario.options));
  const rows = [];
  rows.push(["Recipe set", `${cols.filter((c) => c.kind === "recipe").length} recipes, ${gens.length} generator columns, ${cols.filter((c) => c.kind === "extract").length} resources`]);
  rows.push(["Burning", gens.map((c) => esc(c.name)).join("; ") + ` <span class="muted">(${counted.length} counted against the limit of ${state.scenario.options.maxOtherGenerators})</span>`]);
  rows.push(["Exact structure", `${S.eqCount} equations of rank ${S.rank} over ${S.n} unknowns → <b>${S.free.length}</b> free parameters (after ${state.pins.length} pin${state.pins.length === 1 ? "" : "s"}); ${S.clusters.filter((c) => c.members.length > 1).length} rigid groups`]);
  if (!S.lattice.failure && S.lattice.L) rows.push(["Lattice", `index ${S.lattice.L.index().toLocaleString()} in the free coordinates (1 would mean every free choice is legal)`]);
  if (x) rows.push(["Resource use", `Σ extraction / world supply = ${resUse.toFixed(4)} <span class="muted">(recipe choice optimum ${state.objective != null ? state.objective.toFixed(4) : "?"})</span>`]);
  let html = `<table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>`;
  if (S.contradictions.length) {
    html += `<div class="callout bad"><b>The constraints contradict each other outright</b> (no rational solution): ${S.contradictions.map((c) => c.map(sourceLabel).join(" vs ")).join("; ")}.</div>`;
  }
  if (S.lattice.failure) html += renderConflict();
  if (snapResult && snapResult.violations && snapResult.violations.length) {
    html += `<div class="callout warn"><b>Nearest exact plan breaks ${snapResult.violations.length} inequality${snapResult.violations.length > 1 ? "ies" : ""}</b>
      ${snapResult.status === "infeasible" ? "(the solver proved none satisfies them all)" : ""}:
      <ul>${snapResult.violations.slice(0, 8).map((v) => `<li>${esc(rowName(v.row))}: ${decimalString(v.value, 10)} ${v.side === "below" ? "<" : ">"} ${decimalString(v.bound, 10)}</li>`).join("")}</ul>
      Usually this means a lever below can only take values far apart; widen a band, add an adjustable product, or change recipes.</div>`;
  }
  el.innerHTML = html;
}
function rowName(r) {
  if (r.kind === "output") return `output of ${itemName(r.item)}`;
  return r.name;
}

function renderConflict() {
  const f = S.lattice.failure;
  const cols = S.cols;
  const conf = S.conflict || [];
  const rels = conf.length ? relationsAmong(S, conf) : [];
  const relHtml = rels.map((r) => {
    const lhs = r.terms.map(([j, w], i) => `${i ? (w < 0n ? " − " : " + ") : (w < 0n ? "−" : "")}${(w < 0n ? -w : w) === 1n ? "" : (w < 0n ? -w : w) + "·"}[${esc(cols[j].name)}]`).join("");
    const ratio = div(r.constant, r.unit);
    const contradiction = ratio.d !== 1n;
    return `<li><code>${lhs} = ${qstr(r.constant)}</code> machine-equivalents.
      ${contradiction ? `With every clock on its grid the left side is a multiple of ${decimalString(r.unit)}, but the right side is ${qstr(ratio)} of those units — its denominator has the factor ${factorString(nonDecimalPart(ratio.d) > 1n ? nonDecimalPart(ratio.d) : ratio.d)}. <b>No exact plan.</b>` : "Satisfiable on its own; the contradiction is joint with the other relation(s)."}</li>`;
  }).join("");
  const fp = f.progression;
  let primeHtml = "";
  if (rels.length && !rels.some((r) => div(r.constant, r.unit).d !== 1n)) {
    const ob = primeObstruction(S, rels);
    if (ob) {
      const lines = ob.rows.map((r, i) => {
        const terms = [...r.a].filter(([, v]) => v !== 0n).map(([j, v]) => `${v}·k[${esc(cols[j].name)}]`).join(" + ");
        return `<li><code>${terms || "0"} ≡ ${r.b} (mod ${ob.p})</code></li>`;
      }).join("");
      primeHtml = `<p>Each relation is satisfiable alone; together they fail <b>modulo ${ob.p}</b>. Writing each clock as k × its grid step (k an integer), the relations reduce to:</p><ul>${lines}</ul>
        <p class="small">No integers k satisfy these congruences at once. Every exact plan would need them, so none exists.</p>`;
    }
  }
  return `<div class="callout bad">
    <b>No exact plan exists.</b> ${esc(cols[f.column].name)} could only take the values ${progStr(fp)} (given the conditions before it), and none of them has at most ${S.decimals[cols[f.column].id]} decimals.
    ${conf.length ? `<p>A small set of columns that already can't all be on their grids: <b>${conf.map((j) => esc(cols[j].name)).join(", ")}</b>. The balances force:</p><ul>${relHtml}</ul>${primeHtml}` : ""}
    <p class="small">These relations are exact consequences of the item balances (every other column eliminated); the constants come from the exact rates and pins. See the levers below for which rates would be attainable, or search for a recipe ban that removes the obstruction.</p>
    <button id="searchBans">${banSearch && banSearch.running ? "Stop search" : "Search recipe bans that fix this"}</button>
    <div id="banResults">${renderBanResults()}</div>
  </div>`;
}

function renderBanResults() {
  if (!banSearch) return "";
  const rows = banSearch.results.map((r) => `<tr class="${r.feasible ? "ok" : ""}"><td>${esc(r.ban.name)}</td><td>${esc(r.status)}</td><td>${r.objective != null ? r.objective.toFixed(4) : ""}</td>
    <td>${r.feasible ? `<button data-applyban="${r.ban.id}">ban it</button>` : ""}</td></tr>`).join("");
  return `<p class="small">${banSearch.running ? `Trying ${banSearch.done}/${banSearch.total}…` : `Tried ${banSearch.results.length} bans.`}</p>
    <table class="mini"><thead><tr><th>ban</th><th>result</th><th>resource use</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function runBanSearch() {
  if (banSearch && banSearch.running) { banSearch.stop = true; return; }
  banSearch = { running: true, results: [], done: 0, total: 0, stop: false };
  renderSummary();
  await searchBans(MODEL, XS(), S, {
    candidateColumns, chooseRecipes, maxTrials: 30,
    shouldStop: () => banSearch.stop,
    onProgress: (i, n, r) => { banSearch.done = i; banSearch.total = n; banSearch.results.push(r); const el = $("#banResults"); if (el) el.innerHTML = renderBanResults(); },
  });
  banSearch.running = false;
  renderSummary();
}

function renderLevers() {
  const el = $("#levers");
  if (!S) { el.innerHTML = ""; return; }
  const rows = [];
  for (const L of S.levers) {
    const isPct = L.type === "pin" && L.pin.type === "column";
    const label = L.type === "exact" ? `Exact rate of <b>${esc(itemName(L.item))}</b>` : esc(pinLabel(L.pin));
    const valStr = isPct ? pct(L.value) : `${decimalString(L.value, 12)}${L.type === "pin" && L.pin.type === "scale" ? " sets/min" : "/min"}`;
    let att, verdict;
    if (L.prog) {
      att = progStr(L.prog, isPct);
      verdict = L.ok ? `<span class="good">attainable</span>` : `<span class="bad">not attainable</span>; nearest: ${nearestInProg(L.prog, L.value).map((v) => isPct ? pct(v) : decimalString(v, 12)).join(", ")}`;
    } else {
      att = "—";
      verdict = L.relaxedFails ? `<span class="warn">no exact plan even with this one free</span>` : "";
    }
    const remove = L.type === "pin" ? `<button class="x" data-unpin="${state.pins.indexOf(L.pin)}" title="remove pin">×</button>` : "";
    rows.push(`<tr><td>${label}</td><td>${valStr}</td><td>${att}</td><td>${verdict} ${remove}</td></tr>`);
  }
  const derived = derivedInfo(XS(), S);
  const autoItems = new Set(Object.entries(XS().adjustable).filter(([, b]) => b.auto).map(([k]) => k));
  const autoRows = [];
  for (const D of derived) {
    const x = snapResult && snapResult.x;
    const cur = x ? evalRow({ ell: D.ell }, x) : null;
    const label = D.type === "scale" ? "Scale <b>s</b> of the proportional set" : `Output of <b>${esc(itemName(D.item))}</b>`;
    const unit = D.type === "scale" ? " sets/min" : "/min";
    const pinType = D.type === "scale" ? "scale" : "output";
    let need = "";
    if (D.type === "output" && x && reproRate(XS())) {
      const lo = adjustableLowerRow(S.cols, S.A, D.item, reproRate(XS()));
      const slack = evalRow({ ell: lo }, x);
      const share = sub(cur, slack);
      if (!isZero(share)) need = ` <span class="small muted">(${decimalString(share, 6)} of it rebuilds the factory)</span>`;
    }
    const tr = `<tr class="derived"><td>${label}</td><td>${cur ? decimalString(cur, 10) + unit : "—"}${need}</td><td>${progStr(D.prog, false)}</td>
      <td><input size="9" placeholder="pin to…" data-pinderived="${pinType}" data-item="${D.item || ""}"></td></tr>`;
    if (D.type === "output" && autoItems.has(D.item)) autoRows.push(tr); else rows.push(tr);
  }
  if (autoRows.length) rows.push(`<tr><td colspan="4"><details><summary>${autoRows.length} build-gun ingredients (adjustable, at least their self-reproduction share)</summary>
    <table class="levers"><tbody>${autoRows.join("")}</tbody></table></details></td></tr>`);
  el.innerHTML = rows.length ? `<table class="levers"><thead><tr><th>Lever</th><th>Value</th><th>Attainable values (everything else as is)</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>
    <p class="small muted">For an exact rate or a pin, “attainable” means: drop that one constraint, and these are the values it could take in some exact plan (ignoring inequalities). For the scale and the adjustable outputs it is the set of values the current lattice allows. A step like 9/20000 means the value must be a multiple of it — the 9 is the reason.</p>` : "";
}

function groupOrder() {
  const groups = new Map();
  S.cols.forEach((c, j) => {
    const key = S.param[j].coef.size === 0 ? "fixed" : `c${S.clusterOf[j]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  });
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === "fixed") return -1;
    if (b === "fixed") return 1;
    return groups.get(b).length - groups.get(a).length;
  });
  return keys.map((k) => ({ key: k, members: groups.get(k) }));
}

function renderTable() {
  const el = $("#clocks");
  if (!S) { el.innerHTML = ""; return; }
  const x = snapResult && snapResult.x && !snapResult.violations.length ? snapResult.x : (snapResult && snapResult.x) || null;
  const prog = S.lattice.prog;
  const pinned = new Map(state.pins.filter((p) => p.type === "column").map((p) => [p.id, p]));
  let html = `<table class="clocks"><thead><tr>
    <th>Column</th><th class="num">Total clock</th><th title="decimals of the clock in percent">dec</th>
    <th title="fewest decimals among values this column can take within ±15% of where it is, with everything else free">best ±15%</th>
    <th class="num" title="this column can only move in multiples of this (everything else free)">step</th>
    <th title="equal split over n machines with the fewest decimals (display only)">split</th>
    <th>nice values nearby</th><th>budget</th><th></th></tr></thead><tbody>`;
  for (const g of groupOrder()) {
    const m = g.members;
    let title;
    if (g.key === "fixed") title = `Fixed: determined by exact rates and pins (${m.length})`;
    else if (m.length > 1) title = `Rigid group: these ${m.length} move together — choosing one fixes all`;
    else title = null;
    if (title) html += `<tr class="group"><td colspan="9">${title}</td></tr>`;
    else if (!html.includes('class="group indep"')) html += `<tr class="group indep"><td colspan="9">Independent columns (each in a group of its own)</td></tr>`;
    for (const j of m) html += renderRow(j, x, prog, pinned);
  }
  html += "</tbody></table>";
  el.innerHTML = html;
}

function renderRow(j, x, prog, pinned) {
  const c = S.cols[j];
  const v = x ? x[j] : null;
  const pr = prog ? prog.get(j) : null;
  const budget = S.decimals[c.id];
  const dec = v ? decimalsOf(mul(v, Q(100n))) : null;
  const fewest = pr && v ? fewestDecimalsNear(pr, v, budget) : null;
  const pin = pinned.get(c.id);
  const unit = c.kind === "extract" ? c.io.get(c.resource) : null;
  const split = v && c.kind !== "extract" ? equalSplit(v, 1) : null;
  const nice = pr && v && !pin && !isZero(pr.step) ? niceValuesNear(pr, v, budget, { count: 3 }) : [];
  const name = `${esc(c.name)}${c.alternate ? ' <span class="tag">alt</span>' : ""} <span class="muted small">${esc(c.building)}</span>`;
  const clock = v ? `${pct(v)}${unit ? `<div class="small muted">${decimalString(mul(v, unit), 10)}/min</div>` : ""}` : "—";
  const stepStr = pr ? (isZero(pr.step) ? "fixed" : pct(pr.step)) : "—";
  const niceHtml = nice.map((n) => `<button class="nice ${decClass(n.decimals)}" data-pincol="${c.id}" data-val="${qstr(n.value)}">${pct(n.value)}</button>`).join("");
  const pinBtn = pin
    ? `<button class="pin on" data-unpin="${state.pins.indexOf(pin)}" title="unpin">📌</button>`
    : v ? `<button class="pin" data-pincol="${c.id}" data-val="${qstr(v)}" title="pin at the current value">pin</button>` : "";
  const budgetSel = `<select data-budget="${c.id}">${[0, 1, 2, 3, 4].map((d) => `<option ${d === budget ? "selected" : ""}>${d}</option>`).join("")}</select>`;
  const banBtn = c.kind === "recipe" ? `<button class="x" data-ban="${c.id}" title="ban this recipe and choose again">ban</button>` : "";
  let row = `<tr class="${pin ? "pinned" : ""}" data-row="${c.id}">
    <td class="name"><a href="#" data-toggle="${c.id}">${name}</a></td>
    <td class="num">${clock}</td>
    <td class="${dec != null ? decClass(dec) : ""}">${dec ?? "—"}</td>
    <td class="${fewest != null ? decClass(fewest) : ""}">${fewest ?? "—"}</td>
    <td class="num small">${stepStr}</td>
    <td class="small">${split ? `${split.n} × ${pct(split.clock)}` : ""}</td>
    <td>${niceHtml}<input class="pinin" size="7" placeholder="%" data-pinin="${c.id}"></td>
    <td>${budgetSel}</td><td>${pinBtn} ${banBtn}</td></tr>`;
  if (state.open[c.id]) row += `<tr class="detail"><td colspan="9">${detailHtml(j, v, pr)}</td></tr>`;
  return row;
}

function detailHtml(j, v, pr) {
  const c = S.cols[j];
  const P = S.param[j];
  const parts = [];
  const io = [...c.io].map(([it, r]) => `${toNumber(r) > 0 ? "+" : ""}${decimalString(r, 10)} ${esc(itemName(it))}`).join(", ");
  parts.push(`<p><b>Per machine at 100%:</b> ${io}${c.kind !== "extract" ? `; ${decimalString(c.power, 6)} MW` : ""}.</p>`);
  const bad = [...c.io].filter(([, r]) => nonDecimalPart(r.d) > 1n);
  if (bad.length) parts.push(`<p class="warn">Rates that are not finite decimals: ${bad.map(([it, r]) => `${esc(itemName(it))} ${qstr(r)}`).join(", ")} — any clock of this recipe multiplies them, so its partners inherit the factor ${factorString(nonDecimalPart(bad[0][1].d))}.</p>`);
  if (P.coef.size === 0) {
    const contribs = [...P.contrib].map(([s, val]) => `${pct(val)} from the ${esc(sourceLabel(S.sources[s]))}`);
    parts.push(`<p><b>Fixed.</b> No free parameter moves it: ${contribs.join(" + ") || "it is zero"}.
      ${pr && decimalsOf(mul(P.x0, Q(100n))) > S.decimals[c.id] ? `Its forced value ${pct(P.x0)} has more decimals than allowed, so this alone makes the plan impossible.` : ""}</p>`);
  } else {
    const cl = S.clusters[S.clusterOf[j]];
    if (cl.members.length > 1) {
      const lead = S.cols[cl.lead];
      const r = cl.rel.get(j);
      const others = cl.members.filter((m) => m !== j).slice(0, 12).map((m) => {
        const rm = cl.rel.get(m), rj = cl.rel.get(j);
        // x_m = (alpha_m / alpha_j) (x_j - beta_j) + beta_m
        const ratio = div(rm.alpha, rj.alpha);
        const off = sub(rm.beta, mul(ratio, rj.beta));
        return `[${esc(S.cols[m].name)}] = ${qstr(ratio)} × this${isZero(off) ? "" : ` ${off.n < 0n ? "−" : "+"} ${pct(absq(off))}`}`;
      });
      parts.push(`<p><b>Rigid group of ${cl.members.length}.</b> Exact ratios to this column (they hold in every exact plan):</p><ul class="rel">${others.map((o) => `<li><code>${o}</code></li>`).join("")}${cl.members.length > 13 ? "<li>…</li>" : ""}</ul>
        <p class="small">A ratio p/q whose q has a prime other than 2 or 5 forces this column's clock to carry that prime in its numerator before the partner can be a finite decimal; powers of 2 and 5 only cost decimals.</p>`);
      void lead; void r;
    } else parts.push(`<p>Moves independently of every other column (no rigid partner).</p>`);
    if (pr) parts.push(`<p><b>Attainable values</b> (everything else free, inequalities ignored): ${progStr(pr)}. Fewest decimals possible: ${fewestDecimals(pr, S.decimals[c.id])}.</p>`);
  }
  return parts.join("");
}

function renderWhy() {
  const el = $("#whylist");
  if (!S) { el.innerHTML = ""; return; }
  const items = [];
  const prog = S.lattice.prog;
  if (prog) {
    const x = snapResult && snapResult.x;
    const awkward = S.cols.map((c, j) => {
      const pr = prog.get(j);
      return { c, j, pr, f: fewestDecimals(pr, S.decimals[c.id]), near: x ? fewestDecimalsNear(pr, x[j], S.decimals[c.id]) : null };
    }).filter((r) => r.f > 0 || r.near > 0).sort((a, b) => (b.f - a.f) || (b.near - a.near));
    if (awkward.length) {
      items.push(`<p>These columns <b>cannot be whole-percent</b> with the current recipe set and pins, even if everything else bends (inequalities ignored). “Anywhere” is over all exact plans; “nearby” is within ±15% of the current plan.</p>
        <div class="scroll"><table class="levers"><thead><tr><th>Column</th><th>Attainable values</th><th>fewest decimals anywhere</th><th>nearby</th></tr></thead><tbody>
        ${awkward.map((r) => `<tr><td><b>${esc(r.c.name)}</b></td><td class="mono">${progStr(r.pr)}</td><td class="${decClass(r.f)}">${r.f}</td><td class="${r.near != null ? decClass(r.near) : ""}">${r.near ?? "—"}</td></tr>`).join("")}
        </tbody></table></div>`);
    } else items.push(`<p>Every column could individually be whole-percent; awkwardness here comes only from <i>combinations</i> (pin one column of a rigid group and see what its partners become).</p>`);
  }
  const nd = nonDecimalRates(S.cols);
  if (nd.length) items.push(`<p>Recipes whose per-minute rates are not finite decimals (they inject primes other than 2 and 5): ${nd.map((r) => `<b>${esc(r.col.name)}</b> (${r.bad.map(([it, v]) => `${esc(itemName(it))} ${qstr(v)}`).join(", ")})`).join("; ")}.</p>`);
  const ext = state.scenario.options.extractionUnit;
  items.push(`<p class="small">Extraction is measured in reference extractors of ${esc(ext)}/min. Every miner and well extractor in the game produces a multiple of 30/min at 100%, and 30 = 2·3·5, so every exact ore rate is a multiple of 0.00003/min — a factor 3 hidden in every extraction column.</p>`);
  el.innerHTML = items.join("");
}

// ---------------------------------------------------------------- events

function onResultsClick(e) {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.dataset.toggle) {
    e.preventDefault();
    state.open[t.dataset.toggle] = !state.open[t.dataset.toggle];
    renderTable();
  } else if (t.dataset.pincol) addPin({ type: "column", id: t.dataset.pincol, value: t.dataset.val });
  else if (t.dataset.unpin !== undefined) removePin(Number(t.dataset.unpin));
  else if (t.dataset.ban) ban(t.dataset.ban);
  else if (t.dataset.applyban) { banSearch = null; ban(t.dataset.applyban); }
  else if (t.id === "searchBans") runBanSearch();
}
function onResultsChange(e) {
  const t = e.target;
  if (t.dataset.budget) setBudget(t.dataset.budget, t.value);
  else if (t.dataset.pinin) {
    try {
      const v = div(parseQ(t.value), Q(100n));
      addPin({ type: "column", id: t.dataset.pinin, value: qstr(v) });
    } catch (err) { setStatus(err.message, "bad"); }
  } else if (t.dataset.pinderived) {
    try {
      const v = parseQ(t.value);
      if (t.dataset.pinderived === "scale") addPin({ type: "scale", value: qstr(v) });
      else addPin({ type: "output", item: t.dataset.item, value: qstr(v) });
    } catch (err) { setStatus(err.message, "bad"); }
  }
}

export async function start() {
  load();
  $("#scenario").addEventListener("change", onScenarioChange);
  $("#scenario").addEventListener("click", onScenarioClick);
  for (const id of ["#summary", "#levers", "#clocks"]) {
    $(id).addEventListener("click", onResultsClick);
    $(id).addEventListener("change", onResultsChange);
  }
  $("#source").textContent = `${MODEL.source.data_file} (sha256 ${MODEL.source.data_sha256.slice(0, 12)}…)`;
  render();
  if (state.active) await withBusy("Restoring your last plan…", () => analyzeAndSnap());
  else await chooseAndAnalyze();
}
