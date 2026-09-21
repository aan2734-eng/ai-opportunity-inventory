// Installs tests/loader.mjs for the test process and every test worker.
// Used via `node --import ./tests/register.mjs --test` (see package.json).
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
