/**
 * What every review tool needs.
 *
 * Answer shaping and target resolution. The renderers they share
 * are in `view.ts`, which loads at start where this waits for a
 * tool's first call.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	type BoundTarget,
	type ChangeRef,
	changeInPlay,
	chooseChange,
	explainFailure,
	type FailureContext,
	findReactable,
	type Reactable,
	type ReactableRefusal,
	type ReviewTarget,
	reactables,
	repoElsewhere,
	type Thread,
} from "../../../lib/core/review/index.ts";
import { attachments, reviewEngine } from "../engine.ts";
import type { GateRefusal } from "../gate.ts";
import { rangeChange } from "../range.ts";
import { GLYPH } from "../render.ts";

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

/** What the tools accept for naming a target. */
export interface TargetParams {
	change?: string;
	repo?: string;
	base?: string;
	head?: string;
	refs?: string[];
	/** The branches of a stack being proposed, in dependency order. */
	heads?: string[];
}

/** Whether the caller named a target on this call, rather than leaning on one. */
export function namesTarget(params: TargetParams): boolean {
	return (
		params.change !== undefined ||
		(params.base !== undefined && params.head !== undefined) ||
		(params.refs?.length ?? 0) > 0 ||
		(params.heads?.length ?? 0) > 0
	);
}

/**
 * Bind a target kept from an earlier call, such as the one a draft was
 * opened against, so a draft's id can stand for its change.
 *
 * A hosted change is bound from the reference kept, without asking any
 * host. A range or a stack is bound from the checkout it was read in;
 * one kept with no checkout, or whose checkout is gone, cannot be bound
 * again, and the caller has to name it.
 */
export async function boundForTarget(
	pi: ExtensionAPI,
	target: ReviewTarget,
): Promise<BoundTarget | undefined> {
	const { engine } = await reviewEngine(pi);
	if (target.kind === "change") return engine.bound(target.change);
	const root = target.repo.localPath;
	if (root === undefined) return undefined;
	return target.kind === "range"
		? engine.fromLocal(root, { base: target.base, head: target.head })
		: engine.fromLocal(root, { refs: target.refs });
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
	// A stack being proposed names its branches in `heads`, which is the
	// same thing `refs` is for a stack being read. Without this, proposing a
	// stack from a checkout fell through to the attachment and was refused
	// with "Name a change, or a base and head", having been given every
	// branch in the stack.
	if (params.heads && params.heads.length > 0) {
		return engine.fromLocal(params.repo ?? cwd, { refs: params.heads });
	}
	if (params.base && params.head) {
		return engine.fromLocal(params.repo ?? cwd, {
			base: params.base,
			head: params.head,
		});
	}
	const attached = await attachments().list();
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
	// provider guess. A label is for people to read, and is also what
	// they name back: two providers can both claim `owner/repo#number`,
	// and parsing it afresh sent a remark on a Delta change to `gh`.
	const held = attached.find((a) => a.change.label === chosen.label);
	if (held) return engine.bound(held.change);
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
/**
 * The repo an action is about, for the one action that is about a
 * repo rather than a change.
 *
 * Everything else on this surface needs a change, so {@link boundFor}
 * insists on one: a reference, a range, a stack, or the attachment
 * standing in for all three. Listing is the exception, and going
 * through that resolution anyway meant naming the one thing the
 * action is about was refused with "Name a change".
 *
 * The refusal was worse than it read, because the way out was to
 * attach a change in the repo you wanted to list, which means already
 * knowing one of the answers you were asking for. A session that has
 * just started has nothing attached, which is exactly when somebody
 * asks what is open here.
 *
 * A change still wins when there is one, since resolution through it
 * carries the repo it was resolved against. `bound` comes back with
 * it, so the caller can still check a named checkout against it; the
 * question cannot arise on the other path, where the checkout is what
 * was resolved.
 */
export async function repoToList(
	pi: ExtensionAPI,
	params: TargetParams,
	cwd: string,
): Promise<{
	provider: BoundTarget["provider"];
	repo: BoundTarget["repo"];
	bound?: BoundTarget;
}> {
	const named =
		params.change !== undefined ||
		(params.refs?.length ?? 0) > 0 ||
		(params.heads?.length ?? 0) > 0 ||
		(params.base !== undefined && params.head !== undefined);
	if (!named && (await attachments().list()).length === 0) {
		const { engine } = await reviewEngine(pi);
		const serving = await engine.serving(cwd);
		return { provider: serving.provider, repo: serving.repo };
	}
	const bound = await boundFor(pi, params, cwd);
	return { provider: bound.provider, repo: bound.repo, bound };
}

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
	return bound.target.kind === "change" ? bound.target.change : undefined;
}

/**
 * The change rounds and findings are held against: the hosted one, or a
 * local range under its own name. Only for what this harness keeps; a
 * host is only ever handed {@link hostedChange}.
 */
export function reviewedChange(bound: BoundTarget): ChangeRef | undefined {
	return hostedChange(bound) ?? rangeChange(bound);
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
