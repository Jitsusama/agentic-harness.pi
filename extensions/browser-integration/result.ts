/**
 * The answer shape every browser tool returns.
 *
 * One vocabulary for success and refusal keeps the four tools
 * reading alike, and gives the renderers a single detail shape
 * to draw from.
 */

import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

/** What a browser tool reports alongside its text. */
export interface BrowserDetails {
	readonly ok: boolean;
	readonly session: string;
	/** The kind that ran, for the renderers. */
	readonly kind: string;
}

/** An answer the caller asked for. */
export function answer(
	session: string,
	kind: string,
	body: string,
): AgentToolResult<BrowserDetails> {
	return {
		content: [{ type: "text", text: body }],
		details: { ok: true, session, kind },
	};
}

/** A refusal, saying what would let the call through. */
export function refusal(
	session: string,
	kind: string,
	body: string,
): AgentToolResult<BrowserDetails> {
	return {
		content: [{ type: "text", text: body }],
		details: { ok: false, session, kind },
	};
}
