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
	repoElsewhere,
	type Thread,
} from "../../../lib/review/index.js";
import { firstText, renderToolCall } from "../../../lib/ui/index.js";
import { attachmentDir, reviewEngine } from "../engine.js";
import type { GateRefusal } from "../gate.js";
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

/**
 * What to answer when a gate did not approve.
 *
 * One rule for all sixteen write gates. A bare rejection keeps the
 * tool's own wording, because the person said no and nothing else.
 * A rejection somebody annotated, or a redirect, comes back as a
 * refusal carrying what they said, so the model reads it as the
 * instruction it was meant to be rather than as a flat no.
 */
export function declined(decision: GateRefusal, wording: string): Answer {
	return decision.redirect ? refuse(decision.redirect) : say(wording);
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

/**
 * How much of a long answer is shown before Ctrl-O is needed.
 *
 * Chosen so every write answer arrives whole: the longest of them is a
 * batch outcome, a line per item and a url under each. Reads are what
 * this is for, and a diff has no length worth guessing at.
 */
const PREVIEW_LINES = 12;

/** How many lines preview a digest, which stands above them. */
const DIGEST_PREVIEW_LINES = 6;

/**
 * The one line a tool offers about what it just did.
 *
 * A shared renderer has only prose to work with, and prose cannot be
 * summarized without guessing. The tool knows: it counted the files, it
 * ran the round, it published the plan. Where one is offered the
 * collapsed view opens with it, the way every other collapsed result in
 * this package opens with a mark and a count.
 */
function digestOf(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const said = (details as { summary?: unknown }).summary;
	return typeof said === "string" && said !== "" ? said : undefined;
}

/**
 * The renderer every review tool shares.
 *
 * A read can answer with hundreds of lines, and painting all of them
 * pushes the conversation that asked for it off the screen. The
 * collapsed form keeps the head and says how much it is holding; Ctrl-O
 * gives the rest. Short answers are untouched, since a hint under a
 * one-line result is noise about nothing.
 */
export function renderAnswer(
	result: Answer,
	theme: Theme,
	options?: { expanded?: boolean },
	reuse?: unknown,
): Text {
	const text = firstText(result);
	const digest = digestOf(result.details);
	const shown = options?.expanded
		? text
		: digest
			? digested(text, digest, theme)
			: clipped(text, theme);
	const painted = isRefusal(result.details) ? theme.fg("error", shown) : shown;
	// Pi hands back what this returned last time so a redraw updates one
	// component. Building a new one strands the old beside it, which is
	// the ghost row above a finished call.
	if (reuse instanceof Text) {
		reuse.setText(painted);
		return reuse;
	}
	return new Text(painted, 0, 0);
}

/** The head of an answer, with a count of what is not being shown. */
function clipped(text: string, theme: Theme): string {
	const lines = text.split("\n");
	if (lines.length <= PREVIEW_LINES) return text;
	const withheld = lines.length - PREVIEW_LINES;
	return [
		...lines.slice(0, PREVIEW_LINES),
		theme.fg("muted", `... ${withheld} more`),
	].join("\n");
}

/** A digest, a few lines under it, and what is left. */
function digested(text: string, digest: string, theme: Theme): string {
	const lines = text.split("\n");
	const preview = lines.slice(0, DIGEST_PREVIEW_LINES);
	const withheld = lines.length - preview.length;
	return [
		digest,
		...preview,
		...(withheld > 0 ? [theme.fg("muted", `... ${withheld} more`)] : []),
	].join("\n");
}

/**
 * How a tool call reads in the transcript.
 *
 * This used to bold the tool and the action together, which meant the two ran
 * into each other and neither stood out. The shared line bolds the tool alone, so
 * the eye finds which tool without reading the row, and the action reads as that
 * tool's own word.
 */
export function renderInvocation(
	theme: Theme,
	tool: string,
	action: string | undefined,
	subject: string | undefined,
	reuse?: unknown,
): Text {
	return renderToolCall(
		{
			tool,
			...(action ? { action } : {}),
			...(subject ? { subject } : {}),
		},
		theme,
		reuse instanceof Text ? reuse : undefined,
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

/**
 * Whether a checkout is a different place from the repo in play.
 *
 * Reads the checkout's origin and hands the comparison to
 * {@link repoElsewhere}. The caller phrases the sentence, because the
 * same disagreement means different things: a branch cannot be
 * proposed into another repo at all, while listing another repo's
 * changes succeeds and answers a question nobody asked.
 */
export async function checkoutElsewhere(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	bound: Pick<BoundTarget, "repo">,
): Promise<{ checkout: string; repo: string } | undefined> {
	let remote: string | undefined;
	try {
		const result = await pi.exec("git", [
			"-C",
			cwd,
			"remote",
			"get-url",
			"origin",
		]);
		remote = result.code === 0 ? result.stdout.trim() : undefined;
	} catch {
		// Not a repo, or no git. Nothing to compare, so nothing to say.
		return undefined;
	}
	return repoElsewhere(remote, bound.repo.key);
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
