/**
 * Public API for the `memory` domain: durable, scoped facts with
 * lifecycle-based retention, not age-based eviction.
 *
 * Deliberately not exported here: resolving which scope currently
 * applies (see scope.ts) and presentation (formatting facts for a
 * particular host's reply shape is the adapter's job).
 */

export { memoryDbPath } from "./paths.ts";
export { serializeScope } from "./scope.ts";
export { openMemoryStore } from "./store.ts";
export type {
	Fact,
	FactStatus,
	MemoryStore,
	RecallQuery,
	RetainInput,
	Scope,
} from "./types.ts";
