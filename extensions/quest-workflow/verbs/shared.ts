/**
 * Shared types and helpers for the quest verb modules.
 *
 * Each verb-family module under `./` (lifecycle, stage,
 * reorder, alias, session, spawn, tree-ops, queries)
 * imports from here. transitions.ts is the dispatcher that
 * wires the action name to one of these handlers.
 */

import type { ToolContext } from "@mariozechner/pi-coding-agent";

export interface QuestToolParams {
	action: string;
	id?: string;
	url?: string;
	title?: string;
	parent?: string;
	kind?: string;
	note?: string;
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
	command?: string;
	cwd?: string;
	sessionId?: string;
	scope?: string;
	force?: boolean;
	dryRun?: boolean;
	skipTree?: boolean;
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

/** Build a structured refusal result. */
export function refuse(guidance: string): QuestResult {
	return { ok: false, guidance };
}

/** Build a structured success result. */
export function ok(
	message: string,
	details?: Record<string, unknown>,
): QuestResult {
	return { ok: true, message, details };
}

/**
 * Read the current pi session id off the tool context.
 * The harness exposes a `sessionManager` with a
 * `getSessionId()` accessor; we accept a caller-supplied
 * fallback for tests and tool params that override it.
 */
export function currentSessionId(
	ctx: ToolContext,
	fallback: string | undefined,
): string | undefined {
	if (fallback) return fallback;
	try {
		const sm = (
			ctx as unknown as {
				sessionManager?: { getSessionId?(): string };
			}
		).sessionManager;
		return sm?.getSessionId?.();
	} catch {
		// session manager probe failed; the caller treats
		// this as "session id unavailable" and surfaces a
		// clean error.
		return undefined;
	}
}
