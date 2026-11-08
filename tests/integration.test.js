// End to end on the real game data: recipe choice, exact structure, snapping.
// The JavaScript verdict (exact lattice empty or not) is cross-checked against
// tools/oracle.py, an independent integer solver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { model } from "./helpers.js";
import { DEFAULT_SCENARIO, cloneScenario } from "../web/src/scenario.js";
import { candidateColumns, chooseRecipes, isGeneratorCounted, expandScenario } from "../web/src/model.js";
import { buildEqualities, relationsAmong, primeObstruction } from "../web/src/exact.js";
import { fullAnalysis, orderColumns } from "../web/src/plan.js";
import { snap } from "../web/src/snap.js";
import { Q, add, mul, div, eq, isInt } from "../web/src/rational.js";

const dir = mkdtempSync(join(tmpdir(), "satsearch-"));
function oracle(cols, sc, pins) {
  const { eqs, n } = buildEqualities(cols, sc, pins);
  const f = join(dir, `sys${Math.random()}.json`);
  writeFileSync(f, JSON.stringify({ n, eqs: eqs.map((e) => ({ coef: [...e.coef].map(([j, v]) => [j, `${v.n}/${v.d}`]), rhs: `${e.rhs.n}/${e.rhs.d}` })) }));
  // the oracle uses one grid for every column, so only call it with uniform decimals
  return execFileSync("python3", ["tools/oracle.py", f, "4"], { encoding: "utf8" }).startsWith("(True");
}

function loosePreset() {
  const s = cloneScenario(DEFAULT_SCENARIO);
  delete s.exact.Desc_SingularityCell_C;
  s.adjustable.Desc_SingularityCell_C = { min: "2", max: "2.001" };
  return s;
}

for (const [name, make] of [["default scenario", () => cloneScenario(DEFAULT_SCENARIO)], ["singularity cells adjustable", loosePreset]]) {
  test(`${name}: choice obeys the rules, verdict matches oracle, plan is exact`, async () => {
    const sc = expandScenario(model, make());
    const cand = candidateColumns(model, sc);
    const ch = await chooseRecipes(cand, sc);
    assert.equal(ch.status, "Optimal");
    const cols = orderColumns(cand.filter((c) => ch.x.has(c.id)));
    // at most one recipe per primary product, at most one counted generator
    const prim = new Map();
    for (const c of cols) if (c.kind === "recipe") prim.set(c.primary, (prim.get(c.primary) || 0) + 1);
    assert.ok([...prim.values()].every((k) => k === 1));
    assert.ok(cols.filter((c) => isGeneratorCounted(c, sc.options)).length <= sc.options.maxOtherGenerators);

    const S = fullAnalysis(cols, sc, [], {});
    assert.equal(!S.lattice.failure, oracle(cols, sc, []), "lattice verdict disagrees with the oracle");
    if (S.lattice.failure) {
      // the reported relations really are contradictions
      const rels = relationsAmong(S, S.conflict);
      assert.ok(rels.length > 0);
      assert.ok(rels.some((r) => !isInt(div(r.constant, r.unit))) || primeObstruction(S, rels), "no stated reason for the conflict");
      return;
    }
    const res = await snap(S, sc, cols.map((c) => ch.x.get(c.id)));
    assert.equal(res.violations.length, 0, `snapped plan violates an inequality (${res.status}): ${res.violations.map((v) => v.row.name).join(", ")}`);
    // exactness: every equality holds in rational arithmetic, every clock on the grid
    const { eqs } = buildEqualities(cols, sc, []);
    for (const e of eqs) {
      let s = Q(0n);
      for (const [j, v] of e.coef) s = add(s, mul(v, res.x[j]));
      assert.ok(eq(s, e.rhs), `equation ${JSON.stringify(e.label)} fails`);
    }
    for (const x of res.x) assert.ok(isInt(mul(x, Q(1000000n))), "clock with more than 4 decimals");

    // pinning a nice value of a free column keeps everything exact
    const j = S.free[0];
    const prog = S.lattice.prog.get(j);
    const pinVal = add(prog.offset, mul(prog.step, Q(1000n)));
    const S2 = fullAnalysis(cols, sc, [{ type: "column", id: cols[j].id, value: `${pinVal.n}/${pinVal.d}` }], {});
    assert.ok(!S2.lattice.failure);
    assert.equal(S2.free.length, S.free.length - 1);
  });
}
