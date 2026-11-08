# Satisfying Search

An exact clock-lattice navigator for Satisfactory production plans. You state what the
factory must make, it picks a recipe set, and then shows the **set of all exact plans**
for that recipe set: which clocks are free, which move together, which values each clock
can take, and why some clocks are forced to be awkward.

The tool is a single self-contained HTML page: `dist/satisfying-search.html`. Open it in a
browser; nothing is installed and nothing is sent anywhere.

## What it computes

**Columns.** Every unknown is a rate measured in machine-equivalents at 100% clock: one
per recipe, one per generator–fuel pair, one per raw resource (counted in reference
extractors of 30/min, a Mk.1 miner on an impure node).

**Legal clock.** A total of *x* machine-equivalents can be built with clocks of at most 4
decimals in percent exactly when 10⁶·*x* is an integer. Splitting across machines neither
helps nor hurts, so machine counts are not modelled. A per-column *budget* of *d* decimals
means 10^(2+d)·*x* is an integer.

**Products.** Each item is in exactly one of four classes:

| class | rule |
|---|---|
| proportional | net output = *s*·*p*ᵢ for one common scale *s* (kept in a band) |
| exact | net output = *e*ᵢ |
| adjustable | min ≤ net output ≤ max; for build-gun ingredients, min includes (1/*T*)·(build cost of the factory's machines) |
| everything else | net output = 0 (raw resources included, after extraction) |

Power is the only inequality row (generation × boost + extra ≥ use + fixed).

**Recipe choice.** A mixed-integer linear program (solved with HiGHS) minimises
Σ extraction / world supply, with at most one recipe per primary product and at most one
generator recipe outside the uranium → plutonium → ficsonium chain. It only chooses the set;
nothing exact depends on its floating-point answer.

**The lattice.** With the set fixed, exact Gaussian elimination (BigInt rationals) writes
every rate as an affine function of *d* free parameters. Requiring every column to be on its
grid turns the free parameters into integers subject to congruences; the solutions form an
affine lattice, kept in Hermite normal form. Every column then ranges over a progression
*offset* + *k*·*step*.

**Rigid groups.** Columns whose rates keep a fixed ratio in every exact plan. A ratio
*p*/*q* with a prime other than 2 or 5 in *q* forces a divisibility; powers of 2 and 5 only
cost decimals.

**Levers.** For each exact rate and each pin, the page drops that one constraint and reports
the values it could take in some exact plan.

**Conflicts.** When no exact plan exists, a deletion filter finds a small set of columns
whose grid conditions already contradict each other, and the balances are reduced to
explicit integer relations among them, e.g.
`1470464·[Extract Uranium] − 211200·[Extract Bauxite] + 9750345·[Versatile Framework] = −3242624/3`:
every term moves in multiples of 10⁻⁶, the right side has a 3 in its denominator, so no plan.

**Snapping.** The concrete plan shown is the lattice point nearest the previous plan that
satisfies every inequality. HiGHS solves it over an LLL-reduced basis (the
Aardal–Hurkens–Lenstra reformulation; reducing the basis took one solve from 19 s to 0.2 s).
The solver's floats only choose integer coordinates; the plan is recomputed and every
inequality re-checked in exact arithmetic.

## What is reproducible and what is not

| claim | status |
|---|---|
| A reported plan balances exactly with every clock on its grid | Exact by construction; re-checked in rational arithmetic, and in `tests/integration.test.js` |
| "No exact plan exists" for a recipe set | Exact; the tests cross-check it against `tools/oracle.py`, an independent integer solver |
| Attainable progressions, rigid groups, conflict relations | Exact consequences of the equalities (inequalities ignored) |
| The recipe set is optimal for its objective | Proven by HiGHS within its tolerances; ties may resolve differently across solver versions |
| The snapped plan is the *nearest* legal plan | Up to the solver's gap (1% relative or 0.001 absolute) |
| Abundance weighting reflects logistics effort | Modelling assumption |

## Findings for the default scenario

The default scenario has Phase 5 at 3/1000 sets/min, exactly 2 Singularity Cells/min (Main Portal) and
5 Alien Power Matrices/min (Augmenter), and equipment at low adjustable rates. Every build-gun
ingredient is adjustable, with net output at least the factory's own machine cost divided by
the self-reproduction time *T*.

* **Smallest T.** The world supply supports *T* ≈ 24.9 min; the default uses 28 min (10% headroom).
  Machines are counted as machine-equivalents, so build cost is linear in the rates.
* **No exact plan with exactly 2 Singularity Cells/min.** The page reduces the obstruction to three
  congruences modulo 3 in grid units: one forces Synthetic Power Shard's clock ≡ 0, another ≡ 2.
  The independent oracle agrees.
* **With Singularity Cells adjustable in 2–2.001/min** (the second preset) there is an exact plan with
  55 free parameters; the nearest one makes 2.00001 cells/min.
* **Nuke Nobelisks decouple part of the nuclear chain.** Uranium extraction and the Encased Uranium
  Cell supply become independent, but the waste-disposal chain stays one rigid group of 11:
  uranium : plutonium : ficsonium plants = 4/3 : 2 : 1, so a ficsonium plant at exactly 100%
  forces uranium plants to 133.3…%, which no clock can hit.

## Layout

| path | role |
|---|---|
| `data/data1.0.json` | SatisfactoryTools export of the game's Docs.json (sha256 checked) |
| `data/game_constants.json` | constants the export lacks, with sources |
| `tools/build_model.py` | data → `build/model.json` (exact rates as `p/q` strings); standard library only |
| `web/src/rational.js` | exact BigInt rationals |
| `web/src/lattice.js` | affine integer lattices in Hermite normal form, cut by congruences |
| `web/src/exact.js` | equalities, exact elimination, rigid groups, lattice, progressions, conflict relations |
| `web/src/model.js` | candidate columns and the recipe-choice program |
| `web/src/snap.js` | inequalities, LLL, nearest legal plan |
| `web/src/plan.js` | orchestration: levers, ban search |
| `web/src/app.js`, `web/index.html` | the page |
| `tools/bundle.js` | inlines everything (including the HiGHS WebAssembly) into `dist/satisfying-search.html` |
| `tools/oracle.py` | independent integer-feasibility check |
| `tests/` | unit tests and end-to-end tests on the real data |

## Running it yourself

You need Node.js 22 and Python 3.11 or newer. In a terminal, from the repository folder:

```sh
npm ci          # install the one dependency (the HiGHS solver) exactly as locked
npm run build   # data -> build/model.json -> dist/satisfying-search.html
npm test        # unit tests, plus the full pipeline on the real data (about 15 s)
```

`npm ci` reads `package-lock.json`, so everyone gets the same solver version. The same three
commands run on every push (`.github/workflows/test.yml`).
