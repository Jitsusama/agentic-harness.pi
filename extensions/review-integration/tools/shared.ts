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
import {
	type BoundTarget,
	type ChangeRef,
	changeInPlay,
	chooseChange,
	createAttachmentStore,
	explainFailure,
	type FailureContext,
	findReactable,
	type Reactable,
	type ReactableRefusal,
	reactables,
	type Thread,
} from "../../../lib/review/index.js";
import { attachmentDir, reviewEngine } from "../engine.js";
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

/**
 * Refuse with a failure, saying which provider was asked and why.
 *
 * Every tool here can be handed a reference whose shape belongs to no system
 * in particular, so every one of them can fail against the wrong backend. The
 * context is optional because a failure can happen before anything is bound,
 * and a bare message is still better than swallowing it.
 */
export function refuseFailure(
	error: unknown,
	context: FailureContext | undefined,
): Answer {
	const message = messageOf(error);
	return refuse(context ? explainFailure(message, context) : message);
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

/**
 * Resolve whatever the caller named into a bound target.
 *
 * A caller who named nothing is not making a mistake. They are
 * working on something, and this is where that gets honoured:
 * the attached change stands in, and which one was used is said
 * out loud by whatever renders the answer.
 */
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
	const attached = await createAttachmentStore(attachmentDir()).list();
	const chosen = changeInPlay(
		params.change,
		undefined,
		attached.map((a) => a.change.label),
	);
	if ("candidates" in chosen) {
		throw new Error(
			attached.length === 0
				? "Name a change, or a base and head, or a list of refs to review. Or attach a change, and every call after it can leave this out."
				: chooseChange(chosen.candidates),
		);
	}
	// An attached change was already resolved once, so bind the
	// reference we kept rather than parsing its label back into a
	// provider guess. A label is for people to read.
	const held = attached.find((a) => a.change.label === chosen.label);
	if (held && params.change === undefined) return engine.bound(held.change);
	return engine.resolve(chosen.label, cwd);
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

/**
 * Find the comment an address names, on the change in play.
 *
 * Shared because both tools that react need the same step, and because the
 * step is the point: what the caller typed is an address off a listing, and
 * the provider needs the comment itself. Reacting used to skip it and hand
 * over a comment invented from the id, which works for a provider that reads
 * nothing else and gives every other one a comment by nobody.
 *
 * Both halves of the conversation are read, since an address may name a remark
 * inside a thread or a message standing on its own and the caller is not
 * obliged to know which.
 */
export async function findReactableOn(
	bound: BoundTarget,
	address: string,
): Promise<Reactable | ReactableRefusal> {
	const change = hostedChange(bound);
	if (!bound.conversation || !change) {
		return {
			reason: "Nothing hosts this target, so it has no comments to react to.",
		};
	}
	const [threads, messages] = await Promise.all([
		bound.conversation.threads(change),
		bound.conversation.messages(change),
	]);
	return findReactable(address, reactables({ threads, messages }));
}
