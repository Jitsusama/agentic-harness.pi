/**
 * Asking the machine about a process, and saying which one you meant.
 *
 * The logic sits in `process.ts` rather than here, as it does for
 * `lib/exec` and `lib/remote`, because the coverage config excludes
 * every `index.ts` by name: a module whose whole implementation is
 * its barrel reports as untested however well tested it is.
 */

export {
	askedOnce,
	isOwner,
	type Owner,
	ownerNow,
	ownerStanding,
	type ProcessFacts,
	SAME_PROCESS_MS,
	sameProcess,
	systemFacts,
} from "./process.js";
