// The congruence lattice against brute force on small random systems.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AffineLattice } from "../web/src/lattice.js";
import { meetGrid } from "../web/src/exact.js";
import { Q, mul, add, isInt, div } from "../web/src/rational.js";

function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
const mod = (a, m) => ((a % m) + m) % m;

test("affine lattice matches brute force (d = 2, 3)", () => {
  const r = rng(7);
  for (let trial = 0; trial < 300; trial++) {
    const d = 2 + Math.floor(r() * 2);
    const conds = [];
    for (let c = 0; c < 1 + Math.floor(r() * 3); c++) {
      const D = 2 + Math.floor(r() * 9);
      conds.push({ a: [...Array(d)].map(() => Math.floor(r() * D)), beta: Math.floor(r() * D), D });
    }
    const L = new AffineLattice(d);
    let ok = true;
    for (const c of conds) ok = L.addCondition(c.a.map(BigInt), BigInt(c.beta), BigInt(c.D)) && ok;
    // brute force over one period box
    const P = conds.reduce((m, c) => m * c.D, 1);
    const sat = (m) => conds.every((c) => mod(c.a.reduce((s, ai, i) => s + ai * m[i], 0) + c.beta, c.D) === 0);
    let count = 0;
    const box = (i, m) => {
      if (i === d) { if (sat(m)) count++; return; }
      for (let v = 0; v < P; v++) { m[i] = v; box(i + 1, m); }
    };
    if (P ** d <= 200000) box(0, []);
    else continue;
    assert.equal(ok, count > 0, `feasibility trial ${trial}`);
    if (!ok) continue;
    // index of the lattice = P^d / (number of solutions in the box)
    assert.equal(Number(L.index()) * count, P ** d, `index trial ${trial}`);
    // random lattice points satisfy every condition
    for (let k = 0; k < 5; k++) {
      const u = [...Array(d)].map(() => BigInt(Math.floor(r() * 21) - 10));
      const m = L.point(u).map(Number);
      assert.ok(sat(m), `point trial ${trial}`);
    }
  }
});

test("meetGrid finds exactly the grid points of a progression", () => {
  const r = rng(11);
  for (let t = 0; t < 200; t++) {
    const o = Q(BigInt(Math.floor(r() * 50)), BigInt(1 + Math.floor(r() * 30)));
    const step = Q(BigInt(1 + Math.floor(r() * 50)), BigInt(1 + Math.floor(r() * 30)));
    const h = Q(1n, BigInt([1, 2, 10, 100][Math.floor(r() * 4)]));
    const m = meetGrid(o, step, h);
    const hits = [];
    for (let k = -400; k <= 400; k++) { const v = add(o, mul(step, Q(BigInt(k)))); if (isInt(div(v, h))) hits.push(k); }
    if (!m) { assert.equal(hits.length, 0); continue; }
    assert.ok(hits.length > 0);
    assert.ok(isInt(div(m.o, h)));
    assert.ok(isInt(div(m.step, h)));
  }
});
