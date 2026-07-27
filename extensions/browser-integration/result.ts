/**
 * The answer shape every browser tool returns.
 *
 * One vocabulary for success and refusal keeps the four tools
 * reading alike, and gives the renderers a single detail shape
 * to draw from.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

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
/**
 * Which session a call without a name should act on.
 *
 * Falling straight through to "default" made a whole class of
 * confusion possible: navigate in a session called fr, then ask
 * for a verdict without repeating the name, and the tool went
 * looking for a session nobody had opened. The right answer was
 * sitting there, alone and unambiguous.
 *
 * So one open session is used, and said out loud so the reader
 * knows which page was judged. Several open sessions stay a
 * refusal, because guessing between them would be worse than
 * asking: the names are listed instead.
 */
export function sessionInPlay(
	asked: string | undefined,
	fallback: string,
	open: readonly string[],
): { name: string; note?: string } | { candidates: readonly string[] } {
	// An explicit name is never second-guessed. Someone who names a
	// session means that session, and a typo is better reported than
	// quietly redirected to whatever else happens to be open.
	if (asked !== undefined) return { name: asked };
	if (open.includes(fallback)) return { name: fallback };
	if (open.length === 1 && open[0] !== undefined) {
		return {
			name: open[0],
			note: `Using session '${open[0]}', the only one open.`,
		};
	}
	return { candidates: open };
}

/** Say which sessions are open, when the choice has to be made. */
export function chooseSession(candidates: readonly string[]): string {
	if (candidates.length === 0) {
		return (
			"No session is open. Navigate somewhere with browser_go " +
			"first, and this will act on it."
		);
	}
	return (
		`Several sessions are open: ${candidates.join(", ")}. Name the ` +
		"one to act on, since picking for you could report on the " +
		"wrong page."
	);
}

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
