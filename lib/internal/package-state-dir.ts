/**
 * Backward-compatible alias for `stateDir` from
 * `./paths.ts`. New code should import `stateDir` directly.
 *
 *     import { stateDir } from "./paths.js";
 *
 * The four XDG kinds (config, data, state, cache) live
 * together in `./paths.ts`. This file exists so the two
 * extensions that already import `packageStateDir` keep
 * working without a churning rename across the package.
 */
import { stateDir } from "./paths.js";

/** @deprecated Use `stateDir` from `./paths.js` instead. */
export function packageStateDir(extension: string): string {
	return stateDir(extension);
}
