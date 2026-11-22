/**
 * The googleapis client, loaded on first use.
 *
 * googleapis bundles a client for every Google API, about 1,800
 * modules, and every extension that imports this package would load
 * all of them at startup. This stands in for its `google` export and
 * loads the real one the first time any API is asked for.
 *
 * It also puts every request on a clock. googleapis sets none of its
 * own, so a request whose peer accepted the connection and then went
 * quiet held its tool call open for as long as the socket lived.
 *
 * Its type names only the six APIs used here, each from its own module
 * under googleapis. The package's root type reaches every API's
 * declarations, 3.4 million lines, three in four of all `tsc` read for
 * this project, and every typecheck of every worktree paid for them.
 */

import { createRequire } from "node:module";
import type { calendar } from "googleapis/build/src/apis/calendar";
import type { docs } from "googleapis/build/src/apis/docs";
import type { drive, GlobalOptions } from "googleapis/build/src/apis/drive";
import type { gmail } from "googleapis/build/src/apis/gmail";
import type { sheets } from "googleapis/build/src/apis/sheets";
import type { slides } from "googleapis/build/src/apis/slides";

/** The part of googleapis' `google` export this package calls. */
interface GoogleApis {
	readonly calendar: typeof calendar;
	readonly docs: typeof docs;
	readonly drive: typeof drive;
	readonly gmail: typeof gmail;
	readonly sheets: typeof sheets;
	readonly slides: typeof slides;
	options(options?: GlobalOptions): void;
}

const require = createRequire(import.meta.url);

/**
 * How long one request may take before it is given up on.
 *
 * Two minutes, well past a large Drive export and short of forever. A
 * caller that wants to stop sooner passes its own signal as well.
 */
export const GOOGLE_REQUEST_TIMEOUT_MS = 2 * 60_000;

let loaded: GoogleApis | undefined;

function load(): GoogleApis {
	if (!loaded) {
		loaded = (require("googleapis") as { google: GoogleApis }).google;
		// Global options are the ones every API factory and every method
		// call inherits; a method's own timeout still overrides it.
		loaded.options({ timeout: GOOGLE_REQUEST_TIMEOUT_MS });
	}
	return loaded;
}

export const google = new Proxy({} as GoogleApis, {
	get(_, property) {
		const real = load();
		const value = Reflect.get(real, property);
		// The API factories read shared options off `this`.
		return typeof value === "function" ? value.bind(real) : value;
	},
});
