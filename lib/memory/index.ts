/**
 * Public surface of the memory library.
 *
 * Durable, quest-scoped facts with lifecycle-based retention:
 * a true fact is never evicted by age, only archived or
 * dropped when its quest concludes, invalidated explicitly, or
 * surfaced for curation past a soft cap.
 */

export { memoryDbPath } from "./paths.ts";
export { resolveScope } from "./scope.ts";
export { openMemoryStore } from "./store.ts";
export type {
	Fact,
	MemoryStore,
	Scope,
} from "./types.ts";
