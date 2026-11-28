/**
 * This package's own folder, as the process loaded it: apart from
 * installed-only.ts, which reads pi's settings through pi's own
 * package, so that the fence's code a script reaches without pi can
 * still tell where the harness lies.
 */

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's own folder, followed, as this process loaded it. */
export function packageRoot(): string {
	const own = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	try {
		return realpathSync(own);
	} catch {
		// A folder that can't be followed is named as it was reached.
		return own;
	}
}
