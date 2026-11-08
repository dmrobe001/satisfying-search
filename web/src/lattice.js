// Affine integer lattices  { p + B u : u in Z^d }  kept in Hermite normal form.
//
// The lattice starts as all of Z^d and is cut down by congruences
//     a . m + beta  ==  0   (mod D)
// one at a time.  B is stored by columns (B.cols[j] is the j-th generator) and
// kept lower-triangular with positive diagonal, every entry left of a diagonal
// entry reduced modulo it (column-style Hermite normal form).  In that form a
// row whose diagonal is 1 is a coordinate that is completely free, which is
// what makes the snapping integer program easy for a branch-and-bound solver.

import { bgcd, begcd, bmod, bfloorDiv, bmodInverse } from "./rational.js";

export class AffineLattice {
  constructor(d) {
    this.d = d;
    this.p = new Array(d).fill(0n);
    this.cols = [];
    for (let j = 0; j < d; j++) {
      const c = new Array(d).fill(0n);
      c[j] = 1n;
      this.cols.push(c);
    }
    this.empty = false;
  }

  clone() {
    const L = new AffineLattice(0);
    L.d = this.d;
    L.p = this.p.slice();
    L.cols = this.cols.map((c) => c.slice());
    L.empty = this.empty;
    return L;
  }

  // index of the lattice in Z^d (product of the diagonal)
  index() {
    let x = 1n;
    for (let i = 0; i < this.d; i++) x *= this.cols[i][i];
    return x;
  }

  // Impose a.m + beta == 0 (mod D).  a: BigInt[d].  Returns false (and marks
  // the lattice empty) if no lattice point satisfies it.
  addCondition(a, beta, D) {
    if (this.empty) return false;
    const d = this.d, C = this.cols;
    if (D === 1n) return true;
    // c_j = a . (column j) mod D ;  t = -(a.p + beta) mod D
    const c = new Array(d);
    let any = false;
    const nz = [];
    for (let i = 0; i < d; i++) if (bmod(a[i], D) !== 0n) nz.push(i);
    for (let j = 0; j < d; j++) {
      let s = 0n;
      const col = C[j];
      for (const i of nz) if (col[i] !== 0n) s += a[i] * col[i];
      c[j] = bmod(s, D);
      if (c[j] !== 0n) any = true;
    }
    let ap = beta;
    for (const i of nz) ap += a[i] * this.p[i];
    const t = bmod(-ap, D);
    if (!any) {
      if (t !== 0n) { this.empty = true; return false; }
      return true;
    }
    // unimodular column operations making c = (0..0, g, 0..0)
    let j0 = -1;
    for (let j = 0; j < d; j++) {
      if (c[j] === 0n) continue;
      if (j0 < 0) { j0 = j; continue; }
      const [g, x, y] = begcd(c[j0], c[j]);
      const ag = c[j0] / g, bg = c[j] / g;
      const ci = C[j0], cj = C[j];
      const ni = new Array(d), nj = new Array(d);
      for (let k = 0; k < d; k++) {
        ni[k] = x * ci[k] + y * cj[k];
        nj[k] = -bg * ci[k] + ag * cj[k];
      }
      C[j0] = ni;
      C[j] = nj;
      c[j0] = g;
      c[j] = 0n;
    }
    const g = c[j0];
    const h = bgcd(g, D);
    if (t % h !== 0n) { this.empty = true; return false; }
    const Dh = D / h;
    const w0 = Dh === 1n ? 0n : bmod((t / h) * bmodInverse(g / h, Dh), Dh);
    const col = C[j0];
    if (w0 !== 0n) for (let k = 0; k < d; k++) this.p[k] += w0 * col[k];
    if (Dh !== 1n) for (let k = 0; k < d; k++) col[k] *= Dh;
    this.hnf();
    this.reduceP();
    return true;
  }

  hnf() {
    const d = this.d, C = this.cols;
    for (let i = 0; i < d; i++) {
      for (let j = i + 1; j < d; j++) {
        const b = C[j][i];
        if (b === 0n) continue;
        const a = C[i][i];
        if (a === 0n) { [C[i], C[j]] = [C[j], C[i]]; continue; }
        const [g, x, y] = begcd(a, b);
        const ag = a / g, bg = b / g;
        const ci = C[i], cj = C[j];
        const ni = new Array(d).fill(0n), nj = new Array(d).fill(0n);
        for (let k = i; k < d; k++) {
          ni[k] = x * ci[k] + y * cj[k];
          nj[k] = -bg * ci[k] + ag * cj[k];
        }
        C[i] = ni;
        C[j] = nj;
      }
      if (C[i][i] === 0n) throw new Error("lattice basis became singular");
      if (C[i][i] < 0n) C[i] = C[i].map((v) => -v);
      const di = C[i][i];
      for (let k = 0; k < i; k++) {
        const q = bfloorDiv(C[k][i], di);
        if (q !== 0n) {
          const ck = C[k].slice(), ci = C[i];
          for (let r = i; r < d; r++) ck[r] -= q * ci[r];
          C[k] = ck;
        }
      }
    }
  }

  reduceP() {
    const d = this.d, C = this.cols, p = this.p;
    for (let i = 0; i < d; i++) {
      const q = bfloorDiv(p[i], C[i][i]);
      if (q !== 0n) for (let r = i; r < d; r++) p[r] -= q * C[i][r];
    }
  }

  // nonzero entries of row i of B, as [j, value] (j <= i)
  row(i) {
    const out = [];
    for (let j = 0; j <= i; j++) if (this.cols[j][i] !== 0n) out.push([j, this.cols[j][i]]);
    return out;
  }

  // Integer u whose point p + B u is close to the real target (nearest plane,
  // using the triangular shape).  Only used to centre the snapping program.
  nearestCoords(target) {
    const d = this.d, C = this.cols, u = new Array(d).fill(0n);
    for (let i = 0; i < d; i++) {
      let r = target[i] - Number(this.p[i]);
      for (let j = 0; j < i; j++) if (C[j][i] !== 0n) r -= Number(C[j][i]) * Number(u[j]);
      u[i] = BigInt(Math.round(r / Number(C[i][i])));
    }
    return u;
  }

  point(u) {
    const d = this.d, m = this.p.slice();
    for (let j = 0; j < d; j++) {
      if (u[j] === 0n) continue;
      const col = this.cols[j];
      for (let i = j; i < d; i++) if (col[i] !== 0n) m[i] += col[i] * u[j];
    }
    return m;
  }
}
