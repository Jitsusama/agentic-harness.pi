/**
 * Public surface of the verification library.
 *
 * Pure decision logic for the tiered verification loop: which
 * check command to run, and what the fast layer should do with
 * the errors it finds. The extension owns the side effects
 * (running servers and commands, injecting messages); this
 * library stays testable data-in, data-out.
 */

export {
	type CheckCommandSources,
	type ResolvedCheck,
	resolveCheckCommand,
} from "./resolve.js";
export {
	type FastLayerInput,
	type FastLayerVerdict,
	type FileError,
	fastLayerVerdict,
} from "./verdict.js";
