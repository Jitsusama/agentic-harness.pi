/**
 * Running a command, as a dependency rather than an import.
 *
 * The whole surface is one type, one result shape and one helper that throws with
 * the backend's own words. It is its own module because two libraries need it and
 * neither owns it.
 */

export {
	type Exec,
	type ExecResult,
	type ProviderDeps,
	run,
} from "./exec.js";
