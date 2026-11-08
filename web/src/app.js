// Browser UI: recipe choice (continuous optimum), then the top-down structure
// of the chosen recipe set: interlocked clusters and their nice settings, and
// the link table with awkward ratios flagged.

import { Q, parseQ, mul, div, add, sub, isZero, toNumber, qstr, decimalString, percentString, decimalsOf, nonDecimalPart, factorString, blcm } from "./rational.js";
import { DEFAULT_SCENARIO, cloneScenario } from "./scenario.js";
import { candidateColumns, chooseRecipes, expandScenario, reproRate, adjustableLowerRow, itemRows } from "./model.js";
import { interlockAnalysis, absorberCost, niceSettings } from "./interlock.js";

const STORE = "satisfying-search-v3";
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const itemName = (id) => (MODEL.items[id] ? MODEL.items[id].name : id);
const nameToItem = new Map(Object.entries(MODEL.items).map(([k, v]) => [v.name.toLowerCase(), k]));
const pct = (q) => `${percentString(q, 12)}%`;

let state = {
  scenario: cloneScenario(DEFAULT_SCENARIO),
  choiceX: null, // {id: float} continuous optimum
  objective: null,
  refs: {}, // {colId: "percent string"} user reference clocks
  locks: {}, // {colId: true}
  clusterDecimals: {}, // {clusterIndex: d}
};
let IA = null;
let found = {}; // clusterIndex -> result
let busy = false;

const XS = () => expandScenario(MODEL, state.scenario);
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* unavailable */ } }
function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE) || "null"); if (s && s.scenario) state = { ...state, ...s }; } catch (e) { /* ignore */ }
}
function setStatus(msg, kind = "") { const el = $("#status"); el.textContent = msg; el.className = `status ${kind}`; }
async function withBusy(msg, fn) {
  if (busy) return;
  busy = true; document.body.classList.add("busy"); setStatus(msg, "working");
  await new Promise((r) => setTimeout(r, 20));
  try { await fn(); } catch (e) { console.error(e); setStatus(`Error: ${e.message}`, "bad"); }
  busy = false; document.body.classList.remove("busy");
}

// ---------------------------------------------------------------- solving

async function choose() {
  await withBusy("Choosing recipes (mixed-integer program)…", async () => {
    const xs = XS();
    const cand = candidateColumns(MODEL, xs);
    const t = performance.now();
    const ch = await chooseRecipes(cand, xs);
    if (!ch.active.length) { setStatus(`Recipe choice: ${ch.status}. Loosen a floor or unban something.`, "bad"); IA = null; render(); return; }
    state.choiceX = Object.fromEntries(ch.x);
    state.objective = ch.objective;
    found = {};
    save();
    analyzeSet();
    setStatus(`Chose ${ch.active.length} columns in ${((performance.now() - t) / 1000).toFixed(1)} s.`, "good");
  });
}

function activeCols() {
  const xs = XS();
  const ids = new Set(Object.keys(state.choiceX || {}));
  return candidateColumns(MODEL, xs).filter((c) => ids.has(c.id));
}
function analyzeSet() {
  if (!state.choiceX) { IA = null; render(); return; }
  IA = interlockAnalysis(MODEL, XS(), activeCols());
  render();
}
// reference clock (machine-equivalents) of column j: typed value, else continuous optimum
function refOf(c) {
  const typed = state.refs[c.id];
  if (typed !== undefined && typed !== "") { try { return toNumber(parseQ(typed)) / 100; } catch (e) { /* fall through */ } }
  return state.choiceX ? state.choiceX[c.id] ?? 0 : 0;
}

function findNice(ci) {
  const cl = IA.clusters[ci];
  const ref = IA.cols.map((c) => refOf(c));
  const decimals = state.clusterDecimals[ci] ?? 1;
  // locked members: impose them as extra one-member relations at the typed value
  const locked = cl.members.filter((j) => state.locks[IA.cols[j].id]);
  const res = niceSettings(IA, cl, ref, { decimals, count: 6, locked, lockedValues: locked.map((j) => lockedValue(IA.cols[j])) });
  found[ci] = res;
  renderClusters();
}
function lockedValue(c) {
  const typed = state.refs[c.id];
  if (typed !== undefined && typed !== "") return div(parseQ(typed), Q(100n));
  return parseQ((state.choiceX[c.id] ?? 0).toFixed(6));
}

// ---------------------------------------------------------------- scenario editor (compact)

function renderScenario() {
  const sc = state.scenario;
  const o = sc.options;
  sc.selfReproduction = sc.selfReproduction || { enabled: true, buildGunAdjustable: true, ratio: "10" };
  sc.infrastructure = sc.infrastructure || { enabled: true, channelM: "20", trackFactor: "2", foundationFactor: "2" };
  const sr = sc.selfReproduction, inf = sc.infrastructure;
  const row = (kind, id, inner) => `<tr><td>${esc(itemName(id))}</td><td>${inner}</td><td><button class="x" data-del="${kind}" data-id="${id}" title="remove">×</button></td></tr>`;
  const banned = (sc.banned || []).map((id) => { const c = MODEL.columns.find((c) => c.id === id); return `<span class="chip">${esc(c ? c.name : id)} <button class="x" data-unban="${id}">×</button></span>`; }).join(" ") || `<span class="muted">none</span>`;
  $("#scenario").innerHTML = `
    <datalist id="items">${Object.values(MODEL.items).map((v) => `<option value="${esc(v.name)}">`).join("")}</datalist>
    <div class="grid3">
      <section><h3>Proportional</h3>
        <table class="mini"><tbody>${Object.entries(sc.proportional.items).map(([id, p]) => row("prop", id, `<input data-k="prop" data-id="${id}" value="${esc(p)}" size="6">`)).join("")}</tbody></table>
        <input list="items" placeholder="add item…" data-add="prop">
        <label>scale <input data-k="scale" value="${esc(sc.proportional.scale)}" size="8"> sets/min</label></section>
      <section><h3>Exact</h3>
        <table class="mini"><tbody>${Object.entries(sc.exact).map(([id, v]) => row("exact", id, `<input data-k="exact" data-id="${id}" value="${esc(v)}" size="6"> /min`)).join("")}</tbody></table>
        <input list="items" placeholder="add item…" data-add="exact"></section>
      <section><h3>Soft floors <span class="muted">min /min</span></h3>
        <table class="mini"><tbody>${Object.entries(sc.adjustable).map(([id, b]) => row("adj", id, `<input data-k="adjmin" data-id="${id}" value="${esc(b.min ?? "0")}" size="5">`)).join("")}</tbody></table>
        <input list="items" placeholder="add item…" data-add="adj">
        <label><input type="checkbox" data-k="sr:buildGunAdjustable" ${sr.buildGunAdjustable ? "checked" : ""}> every build-gun ingredient is a soft floor too</label>
        <label><input type="checkbox" data-k="sr:enabled" ${sr.enabled ? "checked" : ""}> floors cover rebuilding the factory every
          <input data-k="sr:ratio" value="${esc(sr.ratio)}" size="3"> × the Phase 5 time</label></section>
    </div>
    <details class="opts"><summary>Options and bans</summary>
      <div class="optgrid">
        <label>Objective <select data-k="opt:objective"><option value="max" ${(o.objective || "max") === "max" ? "selected" : ""}>largest share of any resource</option><option value="sum" ${o.objective === "sum" ? "selected" : ""}>sum of shares</option></select></label>
        <label>Mining increment <input data-k="opt:extractionUnit" value="${esc(o.extractionUnit)}" size="4"> /min</label>
        <label><input type="checkbox" data-k="inf:enabled" ${inf.enabled ? "checked" : ""}> include belts, pipes, rails, foundations, power in the rebuild</label>
        <label>Belt/pipe per machine stream <input data-k="inf:channelM" value="${esc(inf.channelM)}" size="3"> m</label>
        <label><input type="checkbox" data-k="opt:noMixing" ${o.noMixing ? "checked" : ""}> one recipe per product</label>
        <label>Generator recipes outside the nuclear chain ≤ <input data-k="opt:maxOtherGenerators" value="${esc(o.maxOtherGenerators)}" size="2"></label>
      </div>
      <p><b>Banned:</b> ${banned}</p>
    </details>
    <div class="actions"><button class="primary" id="choose">Choose recipes</button> <button id="reset">Reset to default</button></div>`;
}
function onScenario(e) {
  const t = e.target, sc = state.scenario, k = t.dataset.k;
  if (t.dataset.add && e.type === "change") {
    const id = nameToItem.get(t.value.trim().toLowerCase());
    if (!id) return;
    delete sc.proportional.items[id]; delete sc.exact[id]; delete sc.adjustable[id];
    if (t.dataset.add === "prop") sc.proportional.items[id] = "1";
    if (t.dataset.add === "exact") sc.exact[id] = "1";
    if (t.dataset.add === "adj") sc.adjustable[id] = { min: "1" };
    save(); renderScenario(); return;
  }
  if (!k) return;
  const id = t.dataset.id, v = t.type === "checkbox" ? t.checked : t.value.trim();
  if (k === "prop") sc.proportional.items[id] = v;
  else if (k === "exact") sc.exact[id] = v;
  else if (k === "adjmin") sc.adjustable[id].min = v;
  else if (k === "scale") sc.proportional.scale = v;
  else if (k.startsWith("sr:")) sc.selfReproduction[k.slice(3)] = v;
  else if (k.startsWith("inf:")) sc.infrastructure[k.slice(4)] = v;
  else if (k.startsWith("opt:")) sc.options[k.slice(4)] = k === "opt:maxOtherGenerators" ? Number(v) : v;
  save();
}
function onScenarioClick(e) {
  const t = e.target, sc = state.scenario;
  if (t.dataset.del) {
    const id = t.dataset.id;
    if (t.dataset.del === "prop") delete sc.proportional.items[id];
    if (t.dataset.del === "exact") delete sc.exact[id];
    if (t.dataset.del === "adj") delete sc.adjustable[id];
    save(); renderScenario();
  } else if (t.dataset.unban) { sc.banned = sc.banned.filter((x) => x !== t.dataset.unban); save(); renderScenario(); }
  else if (t.id === "choose") choose();
  else if (t.id === "reset") { state.scenario = cloneScenario(DEFAULT_SCENARIO); state.refs = {}; state.locks = {}; save(); renderScenario(); choose(); }
}

// ---------------------------------------------------------------- results

function render() { renderScenario(); renderNet(); renderClusters(); renderLinks(); }

function renderNet() {
  const el = $("#net");
  if (!IA) { el.innerHTML = `<p class="muted">Press <b>Choose recipes</b>.</p>`; return; }
  const xs = XS();
  const cols = IA.cols;
  const A = itemRows(cols);
  const x = cols.map((c) => state.choiceX[c.id] || 0);
  const tau = reproRate(xs);
  const netOf = (it) => { let s = 0; for (const [j, v] of A.get(it) || []) s += toNumber(v) * x[j]; return s; };
  const rebuildOf = (it) => { if (!tau) return 0; let s = 0; cols.forEach((c, j) => { const b = c.buildCost.get(it); if (b) s += toNumber(b) * x[j]; }); return s * toNumber(tau); };
  const groups = [
    ["Targets", [...Object.keys(xs.proportional.items), ...Object.keys(xs.exact)]],
    ["Soft floors you set", Object.keys(xs.adjustable).filter((k) => !xs.adjustable[k].auto)],
    ["Build-gun ingredients", Object.keys(xs.adjustable).filter((k) => xs.adjustable[k].auto)],
  ];
  const shares = cols.filter((c) => c.kind === "extract" && c.worldSupply).map((c) => [c, (state.choiceX[c.id] || 0) * toNumber(c.io.get(c.resource)) / c.worldSupply]).sort((a, b) => b[1] - a[1]);
  let html = `<p>Map needed: <b>${shares.length ? (100 * shares[0][1]).toFixed(1) : "?"}%</b> of the world's ${shares.length ? esc(itemName(shares[0][0].resource)) : ""}
    (then ${shares.slice(1, 5).map(([c, f]) => `${esc(itemName(c.resource))} ${(100 * f).toFixed(1)}%`).join(", ")}).
    ${tau ? `Rebuild time ${decimalString(div(Q(1n), tau), 4)} min.` : ""} These are the continuous optimum's rates, before any rounding.</p><div class="netgrid">`;
  for (const [title, items] of groups) {
    const rows = items.filter((it) => A.has(it)).map((it) => {
      const n = netOf(it), rb = rebuildOf(it);
      return `<tr><td>${esc(itemName(it))}</td><td class="num">${n.toFixed(3)}</td><td class="num muted">${rb ? rb.toFixed(3) : ""}</td></tr>`;
    }).join("");
    html += `<section><h3>${title}</h3><table class="mini wide"><thead><tr><th></th><th class="num">net /min</th><th class="num">rebuild share</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }
  el.innerHTML = html + "</div>";
}

function memberLabel(j) {
  const c = IA.cols[j];
  return `${esc(c.name)} <span class="muted small">${esc(c.building)}</span>`;
}
function relationHtml(rel) {
  const costs = absorberCost(rel);
  const lhs = rel.terms.map(([j, w], i) => {
    const a = w < 0n ? -w : w;
    return `${i ? (w < 0n ? " − " : " + ") : w < 0n ? "−" : ""}${a === 1n ? "" : `${a}·`}[${esc(IA.cols[j].name)}]`;
  }).join("");
  const hard = costs.filter((c) => c.hard > 1n).map((c) => `${esc(IA.cols[c.j].name)} (${factorString(c.hard)})`);
  return `<li><code>${lhs} = 0</code>
    ${hard.length ? `<div class="small">Adjusted last, these need the rest of the sum divisible by a prime other than 2 or 5: ${hard.join(", ")}. Members with coefficients made only of 2s and 5s absorb any remainder at the cost of a few decimals.</div>` : `<div class="small">Every coefficient is made of 2s and 5s: any member can absorb the remainder.</div>`}</li>`;
}

function renderClusters() {
  const el = $("#clusters");
  if (!IA) { el.innerHTML = ""; return; }
  if (!IA.clusters.length) { el.innerHTML = `<p>No interlocks: every zero-net item has its own producer, so the whole set can be worked top-down.</p>`; return; }
  el.innerHTML = IA.clusters.map((cl, ci) => {
    const res = found[ci];
    const dec = state.clusterDecimals[ci] ?? 1;
    const js = [...cl.members, ...cl.dependents];
    const head = res && res.settings.length ? res.settings.map((_, k) => `<th class="num">option ${k + 1}</th>`).join("") : "";
    const rows = js.map((j) => {
      const c = IA.cols[j];
      const isDep = cl.dependents.includes(j);
      const refStr = state.refs[c.id] ?? "";
      const ph = (100 * (state.choiceX[c.id] || 0)).toFixed(2);
      const opts = res && res.settings.length ? res.settings.map((s) => {
        const v = s.values[res.js.indexOf(j)];
        return `<td class="num dec-${Math.min(decimalsOf(mul(v, Q(100n))), 4)}">${pct(v)}</td>`;
      }).join("") : "";
      return `<tr class="${isDep ? "dep" : ""}"><td>${memberLabel(j)}${isDep ? ' <span class="tag">follows</span>' : ""}</td>
        <td><input size="8" data-ref="${c.id}" value="${esc(refStr)}" placeholder="${ph}"></td>
        <td>${isDep ? "" : `<input type="checkbox" data-lock="${c.id}" ${state.locks[c.id] ? "checked" : ""} title="keep this member at its reference value">`}</td>${opts}</tr>`;
    }).join("");
    return `<div class="cluster">
      <h3>Cluster ${ci + 1}: ${cl.members.length} recipes set from above, ${cl.dependents.length} that follow from them</h3>
      <p class="small">Balances that hold among them in every exact plan (zero-net items between them eliminated):</p>
      <ul class="rels">${cl.relations.map(relationHtml).join("")}</ul>
      <div class="finder">
        <label>Decimals allowed <select data-cdec="${ci}">${[0, 1, 2].map((d) => `<option ${d === dec ? "selected" : ""}>${d}</option>`).join("")}</select></label>
        <button data-find="${ci}">Find nice settings near the reference</button>
        ${res && res.impossible ? `<span class="bad">No setting with ${dec} decimals satisfies these balances (with the locks). Allow more decimals or unlock something.</span>` : ""}
      </div>
      <div class="scroll"><table class="clocks"><thead><tr><th>Recipe</th><th>reference %</th><th>lock</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="small muted">Reference: type a total clock (e.g. 92.5×8 → 740), or leave blank for the continuous optimum shown in grey. Options are exact, satisfy every balance above, and are ranked by relative distance from the reference.</p>
    </div>`;
  }).join("");
}

function linkFlags(L) {
  let bad = 1n;
  for (const t of L.terms) bad = blcm(bad, nonDecimalPart(t.coef.d));
  return bad;
}
function renderLinks() {
  const el = $("#links");
  if (!IA) { el.innerHTML = ""; return; }
  const onlyBad = $("#onlybad") && $("#onlybad").checked;
  const rows = IA.links.filter((L) => !onlyBad || linkFlags(L) > 1n).map((L) => {
    const c = IA.cols[L.j];
    const flag = linkFlags(L);
    const terms = L.terms.map((t) => {
      const nd = nonDecimalPart(t.coef.d);
      return `<span class="${nd > 1n ? "badcoef" : ""}">${t.coef.n < 0n ? "− " : ""}${qstr(t.coef.n < 0n ? Q(-t.coef.n, t.coef.d) : t.coef)}·[${esc(IA.cols[t.j].name)}]</span>`;
    }).join(" + ").replace(/\+ <span class="([^"]*)">− /g, '− <span class="$1">');
    return `<tr><td class="num muted">${IA.depth[L.j]}</td><td>${memberLabel(L.j)}</td><td class="small">${esc(itemName(L.item))}</td><td>${terms}</td>
      <td class="${flag > 1n ? "bad" : "muted"}">${flag > 1n ? factorString(flag) : ""}</td></tr>`;
  }).join("");
  el.innerHTML = `<label class="small"><input type="checkbox" id="onlybad" ${onlyBad ? "checked" : ""}> only links with a prime other than 2 or 5</label>
    <div class="scroll"><table class="clocks"><thead><tr><th>depth</th><th>Recipe</th><th>balances</th><th>= its clock, from its consumers' clocks</th><th>awkward prime</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function onResults(e) {
  const t = e.target;
  if (t.dataset.find !== undefined) findNice(Number(t.dataset.find));
  else if (t.id === "onlybad") renderLinks();
}
function onResultsChange(e) {
  const t = e.target;
  if (t.dataset.ref) { state.refs[t.dataset.ref] = t.value.trim(); save(); }
  else if (t.dataset.lock) { state.locks[t.dataset.lock] = t.checked; save(); }
  else if (t.dataset.cdec !== undefined) { state.clusterDecimals[t.dataset.cdec] = Number(t.value); save(); }
}

export async function start() {
  load();
  $("#scenario").addEventListener("change", onScenario);
  $("#scenario").addEventListener("click", onScenarioClick);
  for (const id of ["#clusters", "#links"]) { $(id).addEventListener("click", onResults); $(id).addEventListener("change", onResultsChange); }
  $("#source").textContent = `${MODEL.source.data_file} (sha256 ${MODEL.source.data_sha256.slice(0, 12)}…)`;
  render();
  if (state.choiceX) { analyzeSet(); setStatus("Restored your last recipe set.", "good"); }
  else await choose();
}
