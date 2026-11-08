// Interlock relations are exact consequences of the balances: they hold for
// the continuous optimum, and nice settings satisfy them exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { model } from "./helpers.js";
import { DEFAULT_SCENARIO, cloneScenario } from "../web/src/scenario.js";
import { candidateColumns, chooseRecipes, expandScenario } from "../web/src/model.js";
import { interlockAnalysis, niceSettings } from "../web/src/interlock.js";
import { Q, add, mul, isZero, decimalsOf } from "../web/src/rational.js";

test("interlock relations hold and nice settings satisfy them", async () => {
  const sc = expandScenario(model, cloneScenario(DEFAULT_SCENARIO));
  const cand = candidateColumns(model, sc);
  const ch = await chooseRecipes(cand, sc);
  const cols = cand.filter((c) => ch.x.has(c.id));
  const IA = interlockAnalysis(model, sc, cols);
  assert.ok(IA.relations.length > 0);
  for (const rel of IA.relations) {
    const s = rel.terms.reduce((acc, [j, w]) => acc + Number(w) * ch.x.get(IA.cols[j].id), 0);
    const scale = rel.terms.reduce((acc, [j, w]) => acc + Math.abs(Number(w)) * ch.x.get(IA.cols[j].id), 0);
    assert.ok(Math.abs(s) <= 1e-6 * scale + 1e-9, "relation fails for the continuous optimum");
  }
  const ref = IA.cols.map((c) => ch.x.get(c.id));
  for (const cl of IA.clusters) {
    const res = niceSettings(IA, cl, ref, { decimals: 1, count: 2 });
    if (res.impossible) continue;
    for (const st of res.settings) {
      const val = new Map(res.js.map((j, i) => [j, st.values[i]]));
      for (const rel of cl.relations) {
        let s = Q(0n);
        for (const [j, w] of rel.terms) s = add(s, mul(Q(w), val.get(j)));
        assert.ok(isZero(s), "nice setting breaks a relation");
      }
      for (const v of st.values) assert.ok(decimalsOf(mul(v, Q(100n))) <= 1);
    }
  }
});
