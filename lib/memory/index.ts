/**
 * Public surface of the memory library.
 *
 * Durable, quest-scoped facts with lifecycle-based retention:
 * a true fact is never evicted by age, only archived or
 * dropped when its quest concludes, invalidated explicitly, or
 * surfaced for curation past a soft cap. The store, types and
 * scope serialization live in agentic-harness.core (shared with
 * the Claude Code adapter, and the database itself: see core's
 * memory/paths.ts for why they share one file, not one each).
 * resolveScope stays here: it derives the current scope from pi's
 * own session log, which a host with no quest system has nothing
 * equivalent to derive from.
 */

export type {
	Fact,
	FactStatus,
	MemoryStore,
	RecallQuery,
	RetainInput,
	Scope,
} from "@jitsusama/agentic-harness.core/memory";
export {
	memoryDbPath,
	openMemoryStore,
	serializeScope,
} from "@jitsusama/agentic-harness.core/memory";
export { resolveScope } from "./scope.js";
