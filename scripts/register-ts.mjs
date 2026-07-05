/**
 * Registers the js-to-ts resolution hook so a maintenance script can
 * import the library's `.js` specifiers that resolve to `.ts` on disk.
 * Use via `node --import ./scripts/register-ts.mjs scripts/<name>.ts`.
 */
import { register } from "node:module";

register("./js-to-ts-resolver.mjs", import.meta.url);
