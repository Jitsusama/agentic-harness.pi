/**
 * What every review tool needs.
 *
 * Answer shaping, target resolution and the two renderers that
 * would otherwise be copied into four tool registrations.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
	BoundTarget,
	ChangeRef,
	Thread,
} from "../../../lib/review/index.js";
import { reviewEngine } from "../engine.js";
import { GLYPH } from "../render.js";

/** What a tool answers with. */
export type Answer = AgentToolResult<unknown>;

/** A successful answer. */
export function say(text: string, details: unknown = { ok: true }): Answer {
	return { content: [{ type: "text", text }], details };
}

/** A refusal, warm and naming what would fix it. */
export function refuse(text: string): Answer {
	return {
		content: [{ type: "text", text: `${GLYPH.refused} ${text}` }],
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

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The renderer every review tool shares. */
export function renderAnswer(result: Answer, theme: Theme): Text {
	const first = result.content?.[0];
	const text = first?.type === "text" ? first.text : "";
	return new Text(
		isRefusal(result.details) ? theme.fg("error", text) : text,
		0,
		0,
	);
}

/** How a tool call reads in the transcript. */
export function renderInvocation(
	theme: Theme,
	tool: string,
	action: string | undefined,
	subject: string | undefined,
): Text {
	const label = theme.fg(
		"toolTitle",
		theme.bold(action ? `${tool} ${action}` : tool),
	);
	return new Text(
		label + (subject ? theme.fg("dim", ` ${subject}`) : ""),
		0,
		0,
	);
}

/** What the tools accept for naming a target. */
export interface TargetParams {
	change?: string;
	repo?: string;
	base?: string;
	head?: string;
	refs?: string[];
}

/** Resolve whatever the caller named into a bound target. */
export async function boundFor(
	pi: ExtensionAPI,
	params: TargetParams,
	cwd: string,
): Promise<BoundTarget> {
	const { engine } = await reviewEngine(pi);
	if (params.refs && params.refs.length > 0) {
		return engine.fromLocal(params.repo ?? cwd, { refs: params.refs });
	}
	if (params.base && params.head) {
		return engine.fromLocal(params.repo ?? cwd, {
			base: params.base,
			head: params.head,
		});
	}
	if (!params.change) {
		throw new Error(
			"Name a change, or a base and head, or a list of refs to review.",
		);
	}
	return engine.resolve(params.change, cwd);
}

/** The hosted change behind a bound target, when there is one. */
export function hostedChange(bound: BoundTarget): ChangeRef | undefined {
	return bound.target.kind === "proposal" ? bound.target.change : undefined;
}

/** The threads on a bound target, or a reason there are none. */
export async function threadsOf(bound: BoundTarget): Promise<Thread[]> {
	const change = hostedChange(bound);
	if (!bound.conversation || !change) {
		throw new Error(
			"Nothing hosts this target, so it has no threads. Compose the review and render it as a document instead.",
		);
	}
	return bound.conversation.threads(change);
}
