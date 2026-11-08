import { test } from "node:test";
import assert from "node:assert/strict";
import { Q, parseQ, add, mul, div, qstr, decimalString, decimalsOf, gcdQ, modQ, factorString, percentString } from "../web/src/rational.js";

test("parse exact decimal spellings", () => {
  assert.equal(qstr(parseQ("0.1")), "1/10");
  assert.equal(qstr(parseQ("25/6")), "25/6");
  assert.equal(qstr(parseQ("-1e-6")), "-1/1000000");
  assert.equal(qstr(parseQ("12.50")), "25/2");
  assert.throws(() => parseQ("abc"));
});

test("arithmetic stays normalised", () => {
  assert.equal(qstr(add(Q(1n, 6n), Q(1n, 3n))), "1/2");
  assert.equal(qstr(mul(Q(2n, 3n), Q(9n, 4n))), "3/2");
  assert.equal(qstr(div(Q(1n), Q(-4n))), "-1/4");
});

test("decimals and repeating expansions", () => {
  assert.equal(decimalsOf(Q(3n, 16n)), 4);
  assert.equal(decimalsOf(Q(1n, 3n)), Infinity);
  assert.equal(decimalString(Q(1n, 6n)), "0.1(6)");
  assert.equal(decimalString(Q(-22n, 7n)), "-3.(142857)");
  assert.equal(percentString(Q(3n, 16n)), "18.75");
});

test("rational gcd and modulo", () => {
  assert.equal(qstr(gcdQ([Q(3n, 4n), Q(9n, 10n)])), "3/20");
  assert.equal(qstr(modQ(Q(7n, 4n), Q(1n, 2n))), "1/4");
  assert.equal(qstr(modQ(Q(-1n, 4n), Q(1n, 2n))), "1/4");
  assert.equal(factorString(360n), "2^3·3^2·5");
});
