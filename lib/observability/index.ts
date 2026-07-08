/**
 * Observability: first-class run telemetry for subagent and
 * council fan-outs.
 *
 * The parent session records one {@link RunRecord} per
 * subagent as it finishes, into a SQLite table kept in its
 * own database file. Rows are queryable on demand, roll up
 * into periodic per-model and per-persona summaries before
 * they age out, and drive a compact status-line figure.
 */

export {
	type RunRecorder,
	type RunRecordInput,
	recordRunEverywhere,
	registerRunRecorder,
	runRecordFrom,
} from "./recorder.js";
export { openRunStore, type RunQuery, type RunStore } from "./store.js";
export type {
	RunCost,
	RunRecord,
	RunRollup,
	RunSummary,
	RunTokens,
	VerifyOutcome,
} from "./types.js";
