/**
 * Answer helpers for the work tools.
 *
 * These are close cousins of `extensions/review-integration/
 * tools/shared.ts`, and that is deliberate rather than
 * overlooked. Two consumers of a four-line helper is a
 * coincidence; three is a pattern worth a home in `lib/ui`. When a
 * third surface wants `say` and `refuse`, move all three then,
 * rather than promoting a shared module on the strength of one
 * duplicate and having to guess at what it should cover.
 *
 * What must not drift is the refusal contract: a refusal carries
 * an `error` in its details, which is what `isRefusal` and the
 * renderer both read. A refusal a caller cannot detect without
 * parsing prose is the failure mode to avoid here.
 */

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderToolCall } from "../../../lib/ui/index.js";

/** What a tool answers with. */
export type Answer = AgentToolResult<unknown>;

/** A successful answer. */
export function say(text: string, details: unknown = { ok: true }): Answer {
	return { content: [{ type: "text", text }], details };
}

/** A refusal, naming what would fix it. */
export function refuse(text: string): Answer {
	return {
		content: [{ type: "text", text }],
		details: { error: text },
	};
}

/** Whether an answer carried a refusal. */
export function isRefusal(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		"error" in details &&
		Boolean((details as { error?: unknown }).error)
	);
}

/** Read a message off anything thrown. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The renderer the work tools share. */
export function renderAnswer(result: Answer, theme: Theme): Text {
	const first = result.content?.[0];
	const body = first?.type === "text" ? first.text : "";
	return new Text(
		isRefusal(result.details) ? theme.fg("error", body) : body,
		0,
		0,
	);
}

/**
 * How a tool call reads in the transcript.
 *
 * This used to draw the whole line muted and never name the tool, so a work call
 * was the one row in a transcript you had to stop and decode. It now uses the
 * shared line, which puts the tool in bold and the rest in plain and dim, the way
 * the browser tools always did.
 */
export function renderInvocation(args: unknown, theme: Theme): Text {
	const a = args as {
		action?: string;
		purpose?: string;
		tree?: string;
		onto?: string;
		name?: string;
	};
	// The purpose names a tree being cut; the tree names one already held. Only
	// one of the two is ever meaningful for a given verb, and the branch or
	// parent is what a stack verb is actually about.
	const subject = a.purpose ?? a.tree ?? a.name;
	return renderToolCall(
		{
			tool: "work",
			action: a.action ?? "trees",
			...(subject ? { subject } : {}),
			...(a.onto ? { notes: [`onto ${a.onto}`] } : {}),
		},
		theme,
	);
}
