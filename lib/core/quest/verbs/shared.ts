/**
 * Shared types and helpers for the quest verb modules.
 *
 * The portable subset of agentic-harness.pi's verbs/shared.ts:
 * `currentSessionId` and `isPersistedSession` are dropped, since
 * both duck-type pi's own `ctx.sessionManager` (its resident
 * session id and persistence flag) and have no equivalent in an
 * adapter with no such session manager. Each adapter supplies its
 * own answer to "what session am I" -- pi from its ExtensionContext,
 * a CLI-driven adapter from whatever it has (an env var, a flag, or
 * nothing at all).
 */

export interface QuestToolParams {
	action: string;
	id?: string;
	url?: string;
	title?: string;
	parent?: string;
	kind?: string;
	note?: string;
	/** The new text of a document section, without its heading. */
	body?: string;
	reason?: string;
	priority?: string;
	status?: string;
	target?: string;
	ref?: string;
	query?: string;
	since?: string;
	until?: string;
	field?: string;
	refType?: string;
	pattern?: string;
	role?: string;
	name?: string;
	layout?: string;
	/** spawn and restore: the terminal to open in, by driver or launcher id. */
	terminal?: string;
	/** spawn and restore: innermost or outermost, for a nested session. */
	nesting?: string;
	command?: string;
	cwd?: string;
	sessionId?: string;
	scope?: string;
	force?: boolean;
	dryRun?: boolean;
	limit?: number;
	offset?: number;
}

export type QuestResult =
	| { ok: true; message: string; details?: Record<string, unknown> }
	| { ok: false; guidance: string };

export const QUEST_KINDS_SET = new Set(["quest", "subquest", "sidequest"]);
export const DOCUMENT_KINDS_SET = new Set([
	"plan",
	"research",
	"brief",
	"report",
]);

/**
 * Build a structured refusal result.
 *
 * The mark goes on here, in the text the model reads, not only in the
 * colour a human sees. `⊘` was agentic-harness.pi's one mark for
 * no, shared by all its surfaces; reused here for the same reason.
 */
export function refuse(guidance: string): QuestResult {
	return { ok: false, guidance: `${REFUSED} ${guidance}` };
}

/** The shared mark for no. */
const REFUSED = "⊘";

/** Build a structured success result. */
export function ok(
	message: string,
	details?: Record<string, unknown>,
): QuestResult {
	return { ok: true, message, details };
}
