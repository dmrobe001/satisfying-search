"""Independent check of integer feasibility: is there an integer k with E k = b,
where k_j = x_j / grid? Uses column-style Hermite normal form on the integer
matrix (plain Python ints), a different algorithm from the app's congruence
method. Usage: python3 tools/oracle.py system.json [decimals]"""
import json, sys
from fractions import Fraction
from math import gcd, lcm

def solvable(rows, rhs, n):
    # column operations on A (m x n) to lower-triangular form, then forward-solve
    A = [r[:] for r in rows]
    m = len(A)
    col = 0
    pivots = []
    for i in range(m):
        if col >= n: break
        # gcd-combine entries of row i in columns col..n-1 into column col
        while True:
            nz = [j for j in range(col, n) if A[i][j] != 0]
            if not nz: break
            jmin = min(nz, key=lambda j: abs(A[i][j]))
            for r in range(m): A[r][col], A[r][jmin] = A[r][jmin], A[r][col]
            done = True
            for j in range(col + 1, n):
                if A[i][j]:
                    q = A[i][j] // A[i][col]
                    for r in range(m): A[r][j] -= q * A[r][col]
                    if A[i][j]: done = False
            if done: break
        if any(A[i][j] for j in range(col, n)) :
            pivots.append((i, col)); col += 1
    # forward substitution on pivot rows; check non-pivot rows
    y = [0] * n
    for i in range(m):
        s = sum(A[i][j] * y[j] for j in range(col))
        piv = [c for (r, c) in pivots if r == i]
        if piv:
            c = piv[0]
            num = rhs[i] - s
            if num % A[i][c]: return False, f"row {i}: {num} not divisible by {A[i][c]}"
            y[c] = num // A[i][c]
        elif s != rhs[i]:
            return False, f"row {i} inconsistent"
    return True, "ok"

data = json.load(open(sys.argv[1]))
dec = int(sys.argv[2]) if len(sys.argv) > 2 else 4
g = Fraction(1, 10 ** (2 + dec))
n = data["n"]
rows, rhs = [], []
for e in data["eqs"]:
    coef = {j: Fraction(v) * g for j, v in e["coef"]}   # in units of the grid
    b = Fraction(e["rhs"])
    L = lcm(*(c.denominator for c in coef.values()), b.denominator) if coef else b.denominator
    row = [0] * n
    for j, c in coef.items(): row[j] = int(c * L)
    rows.append(row); rhs.append(int(b * L))
print(solvable(rows, rhs, n))
