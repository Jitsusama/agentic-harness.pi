/**
 * Types for cross-session memory: durable facts scoped to a
 * quest, a project, or globally, with lifecycle-based
 * retention rather than age-based eviction.
 */

/** Where a fact applies. Recall widens a quest or project scope to include global. */
export type Scope =
	| { readonly kind: "global" }
	| { readonly kind: "project"; readonly path: string }
	| { readonly kind: "quest"; readonly id: string };

/** A fact's lifecycle status. Only active facts are recalled. */
export type FactStatus = "active" | "invalidated" | "archived";

/** A durable, scoped fact the agent chose to remember. */
export interface Fact {
	readonly id: number;
	/** Serialized scope key (see serializeScope). */
	readonly scope: string;
	readonly text: string;
	readonly tags: readonly string[];
	readonly source?: string;
	readonly status: FactStatus;
	readonly createdAt: number;
	readonly recalledCount: number;
	readonly lastRecalledAt?: number;
}

/** Input to retain a new fact. */
export interface RetainInput {
	readonly scope: Scope;
	readonly text: string;
	readonly tags?: readonly string[];
	readonly source?: string;
}

/** A recall query: facts in a scope, optionally keyword-filtered. */
export interface RecallQuery {
	readonly scope: Scope;
	/** Keyword or tag substring to match. Omit for all facts in scope. */
	readonly text?: string;
	/** Widen to include global facts. Defaults to true. */
	readonly includeGlobal?: boolean;
	/** Maximum facts to return. Defaults to a small budget. */
	readonly limit?: number;
}

/** The memory store's public surface. */
export interface MemoryStore {
	/** Store a durable fact and return it. */
	retain(input: RetainInput): Promise<Fact>;
	/** Recall active facts for a scope, bumping their recall stats. */
	recall(query: RecallQuery): Promise<Fact[]>;
	/** Synthesize a short answer over the facts matching a scope. */
	reflect(query: { scope: Scope; question: string }): Promise<string>;
	/** Amend a fact's text or tags. Returns the updated fact, or null. */
	edit(
		id: number,
		patch: { text?: string; tags?: readonly string[] },
	): Promise<Fact | null>;
	/** Retire a fact so it is never recalled again. */
	invalidate(id: number): Promise<void>;
	/**
	 * Archive or drop every fact in a scope, for when the quest
	 * that produced them concludes or retires. Returns the count
	 * affected.
	 */
	concludeScope(scope: Scope, mode: "archive" | "drop"): Promise<number>;
	/**
	 * The weakest active facts in a scope beyond a soft cap
	 * (least recalled, oldest first), surfaced for curation. Never
	 * deletes; a true old fact is never silently evicted.
	 */
	weakestBeyondCap(scope: Scope, cap: number): Promise<Fact[]>;
	/** Close the underlying database. */
	close(): Promise<void>;
}
