// Exact rational arithmetic on BigInt. A rational is a frozen {n, d} with d > 0
// and gcd(n, d) = 1. Nothing in the planner ever rounds a rational silently.

export function bgcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) [a, b] = [b, a % b];
  return a;
}
export const blcm = (a, b) => (a === 0n || b === 0n ? 0n : (a < 0n ? -a : a) / bgcd(a, b) * (b < 0n ? -b : b));
export const babs = (a) => (a < 0n ? -a : a);

// floor division and non-negative remainder for BigInt
export function bfloorDiv(a, b) {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}
export function bmod(a, m) {
  const r = a % m;
  return r < 0n ? r + (m < 0n ? -m : m) : r;
}
// extended gcd: returns [g, x, y] with a x + b y = g >= 0
export function begcd(a, b) {
  let [r0, r1, x0, x1, y0, y1] = [a, b, 1n, 0n, 0n, 1n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [x0, x1] = [x1, x0 - q * x1];
    [y0, y1] = [y1, y0 - q * y1];
  }
  if (r0 < 0n) return [-r0, -x0, -y0];
  return [r0, x0, y0];
}
export function bmodInverse(a, m) {
  const [g, x] = begcd(bmod(a, m), m);
  if (g !== 1n) throw new Error(`no inverse of ${a} mod ${m}`);
  return bmod(x, m);
}

export function Q(n, d = 1n) {
  n = BigInt(n);
  d = BigInt(d);
  if (d === 0n) throw new Error("zero denominator");
  if (d < 0n) { n = -n; d = -d; }
  const g = bgcd(n, d);
  if (g > 1n) { n /= g; d /= g; }
  return Object.freeze({ n, d });
}
export const ZERO = Q(0n);
export const ONE = Q(1n);

// "p/q", "p", "12.5", "-0.0003", "1e-6"  -> exact rational of that spelling
export function parseQ(s) {
  if (typeof s === "object" && s && "n" in s) return s;
  if (typeof s === "bigint") return Q(s);
  if (typeof s === "number") {
    if (!Number.isFinite(s)) throw new Error(`not finite: ${s}`);
    s = String(s);
  }
  s = String(s).trim().replace(/_/g, "");
  if (s.includes("/")) {
    const [a, b] = s.split("/");
    return div(parseQ(a), parseQ(b));
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) throw new Error(`not a number: "${s}"`);
  const frac = m[3] || "";
  let n = BigInt((m[2] || "0") + frac);
  let d = 10n ** BigInt(frac.length);
  const e = m[4] ? Number(m[4]) : 0;
  if (e > 0) n *= 10n ** BigInt(e);
  if (e < 0) d *= 10n ** BigInt(-e);
  return Q(m[1] === "-" ? -n : n, d);
}

export const add = (a, b) => (a.d === b.d ? Q(a.n + b.n, a.d) : Q(a.n * b.d + b.n * a.d, a.d * b.d));
export const sub = (a, b) => (a.d === b.d ? Q(a.n - b.n, a.d) : Q(a.n * b.d - b.n * a.d, a.d * b.d));
export const mul = (a, b) => (a.n === 0n || b.n === 0n ? ZERO : Q(a.n * b.n, a.d * b.d));
export const div = (a, b) => { if (b.n === 0n) throw new Error("division by zero"); return Q(a.n * b.d, a.d * b.n); };
export const neg = (a) => Q(-a.n, a.d);
export const isZero = (a) => a.n === 0n;
export const sign = (a) => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0);
export const cmp = (a, b) => { const x = a.n * b.d - b.n * a.d; return x > 0n ? 1 : x < 0n ? -1 : 0; };
export const eq = (a, b) => a.n === b.n && a.d === b.d;
export const isInt = (a) => a.d === 1n;
export const abs = (a) => (a.n < 0n ? Q(-a.n, a.d) : a);
export const floorQ = (a) => bfloorDiv(a.n, a.d);
export const roundQ = (a) => bfloorDiv(2n * a.n + a.d, 2n * a.d);
export const qstr = (a) => (a.d === 1n ? `${a.n}` : `${a.n}/${a.d}`);
export function toNumber(a) {
  // safe for huge numerators/denominators too
  const n = Number(a.n), d = Number(a.d);
  if (Number.isFinite(n) && Number.isFinite(d) && Math.abs(n) < 2 ** 53 && d < 2 ** 53) return n / d;
  const shift = BigInt(Math.max(0, a.d.toString().length - 17));
  return Number(a.n / 10n ** shift) / Number(a.d / 10n ** shift);
}
// best rational approximation of a float is never used for exact work; this is
// only for turning solver output (floats) into a starting guess.
export function fromFloat(x, scale = 10n ** 9n) {
  return Q(BigInt(Math.round(x * Number(scale))), scale);
}

// gcd of rationals: largest r with every a_i / r an integer (0 if all zero)
export function gcdQ(list) {
  let num = 0n, den = 1n;
  for (const a of list) {
    if (a.n === 0n) continue;
    // gcd(num/den, a.n/a.d) = gcd(num*a.d, a.n*den) / (den*a.d)
    const g = bgcd(num * a.d, a.n * den);
    den = den * a.d;
    num = g;
    const h = bgcd(num, den);
    num /= h; den /= h;
  }
  return Q(num, den);
}
// representative of a modulo m (m > 0): value in [0, m)
export function modQ(a, m) {
  if (m.n === 0n) return a;
  const k = bfloorDiv(a.n * m.d, a.d * m.n);
  return sub(a, mul(Q(k), m));
}

// ---- decimals ----------------------------------------------------------

// number of decimals a rational needs (Infinity if it repeats)
export function decimalsOf(a) {
  let d = a.d, two = 0, five = 0;
  while (d % 2n === 0n) { d /= 2n; two++; }
  while (d % 5n === 0n) { d /= 5n; five++; }
  return d === 1n ? Math.max(two, five) : Infinity;
}

// exact decimal spelling; repeating part in parentheses, e.g. 1/6 -> "0.1(6)"
export function decimalString(a, maxDigits = 40) {
  const negative = a.n < 0n;
  let n = negative ? -a.n : a.n;
  const d = a.d;
  const ip = n / d;
  let r = n % d;
  if (r === 0n) return (negative ? "-" : "") + ip.toString();
  const digits = [];
  const seen = new Map();
  while (r !== 0n && digits.length < maxDigits) {
    if (seen.has(r)) {
      const i = seen.get(r);
      return (negative ? "-" : "") + `${ip}.${digits.slice(0, i).join("")}(${digits.slice(i).join("")})`;
    }
    seen.set(r, digits.length);
    r *= 10n;
    digits.push((r / d).toString());
    r %= d;
  }
  return (negative ? "-" : "") + `${ip}.${digits.join("")}${r === 0n ? "" : "…"}`;
}

// rational as percent string: 3/16 -> "18.75"
export const percentString = (a, maxDigits = 40) => decimalString(mul(a, Q(100n)), maxDigits);

// prime factorisation of a (small-ish) positive BigInt, as [[p, k], ...]
export function factorize(n) {
  n = babs(n);
  const out = [];
  for (let p = 2n; p * p <= n && p < 1000000n; p += p === 2n ? 1n : 2n) {
    let k = 0;
    while (n % p === 0n) { n /= p; k++; }
    if (k) out.push([p, k]);
  }
  if (n > 1n) out.push([n, 1]);
  return out;
}
export function factorString(n) {
  const f = factorize(n);
  if (!f.length) return "1";
  return f.map(([p, k]) => (k > 1 ? `${p}^${k}` : `${p}`)).join("·");
}
// the part of a denominator that is not 2s and 5s
export function nonDecimalPart(d) {
  d = babs(d);
  while (d % 2n === 0n) d /= 2n;
  while (d % 5n === 0n) d /= 5n;
  return d;
}
