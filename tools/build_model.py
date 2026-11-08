"""Turn the game data into the compact, exact model the web app uses.

Reads   data/data1.0.json        (SatisfactoryTools export of the game's Docs.json)
        data/game_constants.json (the few constants the export lacks, with sources)
Writes  build/model.json

Standard library only.  Every rate is an exact rational written "p/q", because
the app's whole point is exact arithmetic: a float like 0.1 is not 1/10.

Columns of the model (one unknown each, measured in "machine-equivalents"):
  recipe     one production building running the recipe at 100% clock
  generator  one generator burning one fuel at 100% clock
  extract    one *reference extractor* at 100% clock; its output per minute is
             set in the app (default 30/min, a Mk.1 miner on an impure node)

Every column's legal values are therefore the same thing: total clock in
percent with at most 4 decimals, i.e. 10^6 * x is an integer.
"""

import hashlib
import json
import sys
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "data1.0.json"
CONST = ROOT / "data" / "game_constants.json"
OUT = ROOT / "build" / "model.json"

NUCLEAR_FUELS = {"Desc_NuclearFuelRod_C", "Desc_PlutoniumFuelRod_C", "Desc_FicsoniumFuelRod_C"}


def exact(value) -> Fraction:
    """JSON number -> exact Fraction of its decimal spelling (0.1 -> 1/10)."""
    return Fraction(repr(value)) if isinstance(value, float) else Fraction(value)


def fstr(f: Fraction) -> str:
    return str(f.numerator) if f.denominator == 1 else f"{f.numerator}/{f.denominator}"


def main() -> None:
    raw = DATA.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    const = json.loads(CONST.read_text())
    if sha != const["data_file"]["sha256"]:
        sys.exit(f"data1.0.json hash {sha} does not match game_constants.json")
    data = json.loads(raw)
    items, recipes, buildings = data["items"], data["recipes"], data["buildings"]

    # ---- which items can a factory make without hand-gathering? (fixpoint)
    resources = set(data["resources"]) | {"Desc_Water_C"}
    machine_recipes = [r for r in recipes.values() if r["inMachine"]]
    automatable = set(resources)
    waste = const["nuclear_waste_per_rod"]["values"]
    # (inputs, outputs) of every process; burning a rod "makes" its waste
    processes = [([i["item"] for i in r["ingredients"]], [p["item"] for p in r["products"]])
                 for r in machine_recipes]
    processes += [([fuel], [waste[fuel]["item"]]) for fuel in waste]
    changed = True
    while changed:
        changed = False
        for ins, outs in processes:
            if all(i in automatable for i in ins):
                for p in outs:
                    if p not in automatable:
                        automatable.add(p)
                        changed = True

    columns = []
    dropped = []

    # ---- recipes
    for r in sorted(machine_recipes, key=lambda r: r["className"]):
        if not all(i["item"] in automatable for i in r["ingredients"]):
            dropped.append((r["name"], "needs a hand-gathered item"))
            continue
        building = r["producedIn"][0]
        per_min = Fraction(60) / exact(r["time"])
        io = {}
        for i in r["ingredients"]:
            io[i["item"]] = io.get(i["item"], 0) - exact(i["amount"]) * per_min
        for p in r["products"]:
            io[p["item"]] = io.get(p["item"], 0) + exact(p["amount"]) * per_min
        if r["isVariablePower"]:
            power = (exact(r["minPower"]) + exact(r["maxPower"])) / 2
        else:
            power = exact(buildings[building]["metadata"]["powerConsumption"])
        primary = r["products"][0]["item"]
        columns.append({
            "id": r["className"],
            "kind": "recipe",
            "name": r["name"].replace("Alternate: ", ""),
            "alternate": r["alternate"],
            "building": buildings[building]["name"],
            "primary": primary,
            # Converter recipes that make something a miner could dig up instead
            "converterToResource": building == "Desc_Converter_C" and primary in resources,
            "powerMW": fstr(power),
            "io": {k: fstr(v) for k, v in sorted(io.items()) if v != 0},
        })

    # ---- generators: one column per (generator, fuel)
    for gid, g in sorted(data["generators"].items()):
        for fuel in g["fuel"]:
            if fuel not in automatable:
                dropped.append((f"{buildings[gid]['name']} burning {items[fuel]['name']}", "fuel not automatable"))
                continue
            P = exact(g["powerProduction"])
            fuel_per_min = P * 60 / exact(items[fuel]["energyValue"])
            io = {fuel: -fuel_per_min}
            water = P * exact(g["waterToPowerRatio"]) * 60 / 1000
            if water:
                io["Desc_Water_C"] = -water
            if fuel in waste:
                io[waste[fuel]["item"]] = fuel_per_min * waste[fuel]["amount"]
            columns.append({
                "id": f"Gen:{gid}:{fuel}",
                "kind": "generator",
                "name": f"{buildings[gid]['name']}: {items[fuel]['name']}",
                "building": buildings[gid]["name"],
                "fuel": fuel,
                "nuclearChain": fuel in NUCLEAR_FUELS,
                "powerMW": fstr(-P),
                "io": {k: fstr(v) for k, v in sorted(io.items())},
            })

    # ---- extraction: one column per resource, output scaled in the app
    # Power per unit of output (MW per item/min), from the usual extractor.
    extractor_power = {}
    for res in resources:
        if res == "Desc_Water_C":
            extractor_power[res] = Fraction(20, 120)          # Water Extractor
        elif res == "Desc_LiquidOil_C":
            extractor_power[res] = Fraction(40, 120)          # Oil Extractor, normal node
        elif res == "Desc_NitrogenGas_C":
            extractor_power[res] = Fraction(150, 600)         # pressurizer, assumed 600/min
        else:
            extractor_power[res] = Fraction(45, 240)          # Miner Mk.3, normal node
    supply = const["world_supply_per_min"]["values"]
    for res in sorted(resources):
        columns.append({
            "id": f"Extract:{res}",
            "kind": "extract",
            "name": f"Extract {items[res]['name']}",
            "building": "Extractor",
            "resource": res,
            "powerMWPerUnitRate": fstr(extractor_power[res]),
            "worldSupply": supply.get(res),
        })

    used = {i for c in columns for i in c.get("io", {})} | resources
    model = {
        "about": "Exact model for satisfying-search; generated by tools/build_model.py. Do not edit.",
        "source": {
            "data_file": const["data_file"]["source"],
            "data_sha256": sha,
            "constants_file": "data/game_constants.json",
        },
        "items": {
            k: {"name": items[k]["name"], "liquid": items[k]["liquid"]}
            for k in sorted(used)
        },
        "resources": sorted(resources),
        "columns": columns,
        "dropped": dropped,
        "constants": {
            "phase5": const["phase5_requirement"]["values"],
            "fixed_consumers": const["fixed_consumers"],
        },
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(model, indent=1))
    kinds = {}
    for c in columns:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    print(f"wrote {OUT.relative_to(ROOT)}: {len(model['items'])} items, columns {kinds}, dropped {len(dropped)}")


if __name__ == "__main__":
    main()
