/**
 * The `review_draft` tool: composing a review, then landing it.
 *
 * This is the tool that makes a review one act instead of a
 * dozen errands. Findings, replies into other people's threads,
 * resolutions, reactions and a verdict accumulate in a draft
 * that survives the session; `plan` says exactly what
 * publishing would do; `publish` does it behind a gate; and
 * `render` covers the case where nothing hosts the target at
 * all.
 *
 * What a call does, loaded on its first call; the registration is
 * `draft-tool.ts`. This file composes the draft. Planning and
 * publishing it are in `draft-publish.ts`, settling a finding in
 * `draft-decide.ts`, the fix queue in `draft-fixes.ts`, and whose turn
 * it is to save a draft in `draft-turns.ts`.
 */

import type {
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Anchor,
	type BoundTarget,
	createDraftStore,
	type DiffSide,
	isReactableRefusal,
	type Reaction,
	type ReviewDraft,
	type ReviewTarget,
	resumeDraft,
	targetKey,
	type Verdict,
} from "../../../lib/core/review/index.ts";
import { sessionCwd } from "../../../lib/core/session/index.ts";
import { draftDir, reviewEngine } from "../engine.ts";
import { anchorLabel, GLYPH } from "../render.ts";
import { decideFinding } from "./draft-decide.ts";
import { walkFixes } from "./draft-fixes.ts";
import { planOrPublish, publishStack } from "./draft-publish.ts";
import type { DraftParams } from "./draft-tool.ts";
import { inTurns, turnsFor } from "./draft-turns.ts";
import type { Settle } from "./settle.ts";
import {
	type Answer,
	boundFor,
	boundForTarget,
	findReactableOn,
	namesTarget,
	refuse,
	refuseFailure,
	reviewedChange,
	say,
	threadsOf,
} from "./shared.ts";

/** A target as a person names it. */
function targetLabel(target: ReviewTarget): string {
	if (target.kind === "change") return target.change.label;
	if (target.kind === "range") return `${target.base}..${target.head}`;
	return target.refs.join(", ");
}

/** The draft's contents, listed for a person. */
function draftLines(draft: ReviewDraft): string {
	const verdict = draft.state.verdict
		? `${GLYPH.verdict} ${draft.state.verdict}${draft.state.summary ? `: ${draft.state.summary}` : ""}`
		: "no verdict yet";
	const items = draft.state.items.map((item) => {
		if (item.kind === "finding") {
			return `${GLYPH.finding} #${item.id} ${anchorLabel(item.anchor)}\n     ${item.body}`;
		}
		if (item.kind === "reply") {
			return `${GLYPH.thread} #${item.id} reply into ${item.thread.id}\n     ${item.body}`;
		}
		if (item.kind === "resolution") {
			return `${GLYPH.resolved} #${item.id} resolve ${item.thread.id}`;
		}
		if (item.kind === "unresolution") {
			return `${GLYPH.unresolved} #${item.id} reopen ${item.thread.id}`;
		}
		// Said by who wrote it and what they said, rather than by the
		// provider's id for it. Every other listing in the surface addresses a
		// comment as [C3] or names its author, and this line still read `on
		// rc:5136027779`, which is the id nobody could discover in the first
		// place. Reviewing a draft before publishing it means checking each
		// item is aimed where you meant, and an id is the one form that cannot
		// be checked by looking at it.
		return `${GLYPH.reaction} #${item.id} ${item.reaction} on ${item.subject.author.id}: ${firstLine(item.subject.body)}`;
	});
	return `${GLYPH.document} draft ${draft.id}\n${verdict}\n${items.join("\n") || "nothing in it yet"}`;
}

/**
 * The opening line of a body, for naming something in a list.
 *
 * A comment can be a page long, and a draft listing has one line per item.
 */
function firstLine(body: string): string {
	const opener = body.split("\n")[0] ?? "";
	return opener.length > 60 ? `${opener.slice(0, 59)}\u2026` : opener;
}

/** Do what a `review_draft` call asks, once the tool is first called. */
export async function runDraft(
	pi: ExtensionAPI,
	params: DraftParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionToolContext,
): Promise<Answer> {
	// Held outside the try so a failure can say which provider was asked.
	let bound: BoundTarget | undefined;
	const store = createDraftStore(draftDir());
	try {
		let target: ReviewTarget;
		if (params.draft) {
			const found = await resumeDraft(params.draft, { store });
			if (!found) {
				return refuse(`There is no draft called ${params.draft}.`);
			}
			target = found.state.target;
			// A draft is opened against a change and keeps it, so its id
			// stands for that change. Without this every action that reads
			// the conversation refused a draft id, and naming the change as
			// well, as the refusal said, was ignored and refused again.
			if (namesTarget(params)) {
				bound = await boundFor(pi, params, sessionCwd(ctx));
				if (targetKey(bound.target) !== targetKey(target)) {
					return refuse(
						`Draft ${params.draft} is for ${targetLabel(target)}, not ${targetLabel(bound.target)}. Name one or the other.`,
					);
				}
			} else {
				bound = await boundForTarget(pi, target).catch(() => undefined);
			}
		} else {
			bound = await boundFor(pi, params, sessionCwd(ctx));
			target = bound.target;
		}
		const keys = await turnsFor(params.action, target, bound);
		return await inTurns(keys, signal, async () => {
			// Opened inside the turn, so it reads what the call before
			// this one saved rather than what was there when both began.
			const reopened = params.draft
				? await resumeDraft(params.draft, { store })
				: await (await reviewEngine(pi)).engine.openDraft(target);
			if (!reopened) {
				return refuse(`There is no draft called ${params.draft}.`);
			}
			return act(reopened);
		});
	} catch (error) {
		return refuseFailure(error, bound);
	}

	async function act(draft: ReviewDraft): Promise<Answer> {
		try {
			if (params.action === "open" || params.action === "show") {
				return say(draftLines(draft), {
					ok: true,
					id: draft.id,
					items: draft.state.items.length,
				});
			}

			if (params.action === "decide") {
				return decideFinding(bound, draft, params);
			}

			if (
				params.action === "fix-next" ||
				params.action === "fix-done" ||
				params.action === "fix-skip" ||
				params.action === "fix-answered" ||
				params.action === "fixes" ||
				params.action === "take-threads"
			) {
				const change = bound && reviewedChange(bound);
				if (!bound || !change) {
					return refuse(
						"The fix queue belongs to a change, and this draft's could not be found again. Name the change on this call.",
					);
				}
				return walkFixes(bound, change, params);
			}

			if (params.action === "publish-stack") {
				if (!bound) {
					return refuse(
						"Publishing a stack needs the stack read, and this draft's could not be found again. Name a change in it on this call.",
					);
				}
				return publishStack(pi, bound, store, ctx, signal);
			}

			if (params.action === "finding") {
				if (!params.path || !params.body) {
					return refuse("A finding needs a path and a body.");
				}
				const anchor: Anchor =
					params.line === undefined
						? { subject: "file", path: params.path }
						: {
								subject: "line",
								path: params.path,
								blob: (params.side ?? "new") as DiffSide,
								line: params.line,
								...(params.startLine !== undefined
									? { startLine: params.startLine }
									: {}),
							};
				const id = await draft.addFinding({ anchor, body: params.body });
				return say(`${GLYPH.finding} #${id} noted at ${anchorLabel(anchor)}`, {
					ok: true,
					item: id,
				});
			}

			if (params.action === "verdict") {
				if (!params.verdict) return refuse("Name the verdict.");
				await draft.setVerdict(params.verdict as Verdict, params.body);
				return say(
					`${GLYPH.verdict} ${params.verdict} recorded in the draft. Nothing has been sent yet.`,
				);
			}

			if (params.action === "drop") {
				if (!params.item) return refuse("Name the item to drop.");
				await draft.remove(params.item);
				return say(`dropped #${params.item}.`);
			}

			if (params.action === "react") {
				if (!params.reaction || !params.comment) {
					return refuse(
						"Reacting needs a reaction and the comment to put it on, addressed as the [C#] or [M#] a listing prints.",
					);
				}
				// The same reason replying needs it: an address is resolved
				// against the conversation, and a draft id alone cannot say
				// which conversation.
				if (!bound) {
					return refuse(
						"Reacting needs the change itself, so the comment can be found, and this draft's could not be found again. Name the change on this call.",
					);
				}
				const found = await findReactableOn(bound, params.comment);
				if (isReactableRefusal(found)) return refuse(found.reason);
				// The whole comment goes into the draft, not an id typed into
				// it. A draft outlives the call that filled it, so an
				// unresolved id here would be a wrong reaction published later
				// by somebody reading a plan that looked right.
				const id = await draft.react(
					found.message,
					params.reaction as Reaction,
				);
				return say(
					`${GLYPH.reaction} #${id} queued in the draft, on ${found.label} ${found.message.author.id}.`,
				);
			}

			if (params.action === "render") {
				const document = draft.render();
				return say(`${GLYPH.document} ${document.markdown}`);
			}

			if (
				params.action === "reply" ||
				params.action === "resolve" ||
				params.action === "unresolve"
			) {
				if (!bound) {
					return refuse(
						"Replying, resolving or reopening needs the change's threads, and this draft's change could not be found again. Name the change on this call.",
					);
				}
				const threads = await threadsOf(bound);
				const thread = threads[(params.thread ?? 0) - 1];
				if (!thread) {
					return refuse(
						`There is no [T${params.thread ?? "?"}]. Read the threads first.`,
					);
				}
				if (params.action === "resolve") {
					const id = await draft.resolveThread(thread);
					return say(`${GLYPH.resolved} #${id} queued in the draft.`);
				}
				if (params.action === "unresolve") {
					const id = await draft.reopenThread(thread);
					return say(`${GLYPH.unresolved} #${id} queued in the draft.`);
				}
				if (!params.body) return refuse("A reply needs a body.");
				const id = await draft.replyTo(thread, params.body);
				// Two items rather than one, appended in the order they will
				// happen. A combined item would be a second kind of reply that
				// only the draft knows about, and dropping the settling would
				// mean editing the reply.
				const settle = params.settleThread as Settle | undefined;
				const also =
					settle === "resolve"
						? await draft.resolveThread(thread)
						: settle === "unresolve"
							? await draft.reopenThread(thread)
							: undefined;
				return say(
					[
						`${GLYPH.thread} #${id} queued in the draft.`,
						...(also
							? [
									`${settle === "resolve" ? GLYPH.resolved : GLYPH.unresolved} #${also} queued too, ${settle === "resolve" ? "resolving" : "reopening"} the same thread.`,
								]
							: []),
					].join("\n"),
				);
			}

			return await planOrPublish(bound, draft, params.action, ctx, signal);
		} catch (error) {
			return refuseFailure(error, bound);
		}
	}
}
