/**
 * Running a command, as a dependency rather than an import.
 *
 * The whole surface is one type, one result shape and one helper that throws with
 * the backend's own words. It is its own module because two libraries need it and
 * neither owns it.
 */

export { callSignal, withCallSignal } from "./call-signal.ts";
export {
	type Exec,
	type ExecResult,
	type ProviderDeps,
	run,
} from "./exec.ts";
export {
	EXIT_ABORTED,
	EXIT_TIMED_OUT,
	NONINTERACTIVE_ENV,
	type SpawnExecOptions,
	spawnExec,
} from "./spawn.ts";
