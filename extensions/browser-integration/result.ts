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

/**
 * Explain a session that is not there, rather than implying the
 * caller made the name up.
 *
 * A session that timed out looks identical to one that never
 * existed, and the difference matters: the caller did nothing
 * wrong, their navigation and emulation are simply gone, and
 * knowing that is what stops them hunting for a typo.
 */
export function missingSession(
	name: string,
	departure: "idle" | "closed" | undefined,
	opens: string,
): string {
	if (departure === "idle") {
		return (
			`Session '${name}' was closed after sitting idle, so its page, ` +
			`storage and emulation are gone. ${opens}`
		);
	}
	if (departure === "closed") {
		return `Session '${name}' was closed earlier. ${opens}`;
	}
	return `No session '${name}'. ${opens}`;
}
