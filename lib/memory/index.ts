/**
 * Public surface of the memory library.
 *
 * Durable, quest-scoped facts with lifecycle-based retention:
 * a true fact is never evicted by age, only archived or
 * dropped when its quest concludes, invalidated explicitly, or
 * surfaced for curation past a soft cap.
 */

export { resolveScope, serializeScope } from "./scope.js";
export { openMemoryStore } from "./store.js";
export type {
	Fact,
	FactStatus,
	MemoryStore,
	RecallQuery,
	RetainInput,
	Scope,
} from "./types.js";
