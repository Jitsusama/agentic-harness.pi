/**
 * Preload for a node child that imports this package's source:
 * `node --import ./tests/support/ts-source.mjs child.ts`.
 */

import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
