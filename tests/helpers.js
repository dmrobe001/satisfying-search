import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setHighsFactory } from "../web/src/solver.js";
const require = createRequire(import.meta.url);
const loader = require("highs");
setHighsFactory(() => loader());
export const model = JSON.parse(readFileSync(new URL("../build/model.json", import.meta.url)));
