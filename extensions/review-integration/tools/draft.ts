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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	type Anchor,
	type BoundTarget,
	createDecisionLedger,
	createDraftStore,
	createFindingStore,
	createFixQueue,
	createVisitLog,
	type DiffModel,
	type DiffSide,
	type DraftStore,
	describeSubject,
	isReactableRefusal,
	publishAcross,
	type Reaction,
	type ReviewDraft,
	type ReviewTarget,
	resumeDraft,
	type StackPublishEntry,
	subjectOf,
	type Thread,
	type Verdict,
} from "../../../lib/review/index.js";
import { count, displayPath } from "../../../lib/ui/index.js";
import {
	decisionDir,
	draftDir,
	findingDir,
	fixDir,
	reviewEngine,
	visitDir,
} from "../engine.js";
import { confirmBatch } from "../gate.js";
import {
	anchorLabel,
	GLYPH,
	outcomeNarration,
	planNarration,
	proseComplaint,
} from "../render.js";
import { treeForFixing } from "../work.js";
import { PLAN_TAB, publishTabs } from "./publish-gate.js";
import type { Settle } from "./settle.js";
import {
	type Answer,
	boundFor,
	findReactableOn,
	hostedChange,
	refuse,
	refuseFailure,
	renderAnswer,
	renderInvocation,
	say,
	threadsOf,
} from "./shared.js";

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

/** Register the `review_draft` tool. */
export function registerDraftTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_draft",
		label: "Review Draft",
		description:
			"Compose a review and land it in one go: add anchored findings, replies into existing threads, resolutions, reactions and a verdict; see exactly what publishing will do, including what degrades and why; then publish, or render the review as a document when nothing hosts the target.",
		promptSnippet:
			"Compose a review as a draft, see what publishing would do, then publish or render it.",
		promptGuidelines: [
			"Always plan before publishing, and tell the user what will degrade and why rather than letting them discover it afterwards.",
			"A draft persists, so a review can be built up across a session and picked back up by id.",
			"When the target has nowhere to post, render the draft as a document instead of reporting failure.",
			"Publishing keeps whatever did not land, so a retry sends only the remainder. Say so if something fails.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("open"),
					Type.Literal("show"),
					Type.Literal("finding"),
					Type.Literal("decide"),
					Type.Literal("reply"),
					Type.Literal("resolve"),
					Type.Literal("unresolve"),
					Type.Literal("react"),
					Type.Literal("verdict"),
					Type.Literal("drop"),
					Type.Literal("plan"),
					Type.Literal("publish"),
					Type.Literal("publish-stack"),
					Type.Literal("render"),
					Type.Literal("fix-next"),
					Type.Literal("fix-done"),
					Type.Literal("fix-skip"),
					Type.Literal("fix-answered"),
					Type.Literal("fixes"),
					Type.Literal("take-threads"),
				],
				{ description: "What to do with the draft." },
			),
			change: Type.Optional(
				Type.String({ description: "The hosted change under review." }),
			),
			repo: Type.Optional(Type.String({ description: "Checkout path." })),
			base: Type.Optional(Type.String({ description: "Base of a range." })),
			head: Type.Optional(Type.String({ description: "Head of a range." })),
			refs: Type.Optional(
				Type.Array(Type.String(), { description: "Refs of a local stack." }),
			),
			draft: Type.Optional(
				Type.String({ description: "Draft id, to resume a specific one." }),
			),
			path: Type.Optional(
				Type.String({
					description: "For finding: the file the remark is about.",
				}),
			),
			line: Type.Optional(
				Type.Number({
					description:
						"For finding: the line it points at; omit for a whole-file remark.",
				}),
			),
			startLine: Type.Optional(
				Type.Number({
					description: "For finding: the first line of a range.",
				}),
			),
			side: Type.Optional(
				Type.Union([Type.Literal("old"), Type.Literal("new")], {
					description: "For finding: which side of the diff. Defaults to new.",
				}),
			),
			body: Type.Optional(
				Type.String({
					description:
						"For finding, reply, verdict, decide and fix-answered: the text. The remark for finding, the answer for reply, the summary for verdict, the finding in your own words for decide, and what you said for fix-answered.",
				}),
			),
			thread: Type.Optional(
				Type.Number({
					description:
						"For reply, resolve and unresolve: the 1-based [T#] index of a thread.",
				}),
			),
			// Not `settle`, which this tool already uses for what becomes of a
			// finding. One word, one meaning: a parameter bag where `settle`
			// means two things depending on the action is a bag nobody can read.
			settleThread: Type.Optional(
				Type.Union(
					[
						Type.Literal("resolve"),
						Type.Literal("unresolve"),
						Type.Literal("leave"),
					],
					{
						description:
							"For reply: what to do with the thread once the reply lands, queued as its own item beside the reply. Defaults to leaving it as it is.",
					},
				),
			),
			reaction: Type.Optional(
				Type.String({ description: "For react: the reaction name." }),
			),
			comment: Type.Optional(
				Type.String({
					description:
						"For react: which comment, as the [C#] a thread listing prints beside a remark or the [M#] a messages listing prints beside a top-level one.",
				}),
			),
			verdict: Type.Optional(
				Type.Union(
					[
						Type.Literal("approve"),
						Type.Literal("request-changes"),
						Type.Literal("comment"),
					],
					{
						description:
							"For verdict: what to say about the change as a whole.",
					},
				),
			),
			commit: Type.Optional(
				Type.String({
					description:
						"For fix-done: the commit that landed the fix. Required, since a fix recorded without one cannot be checked.",
				}),
			),
			item: Type.Optional(
				Type.String({
					description: "For drop: the item id to take out of the draft.",
				}),
			),
			finding: Type.Optional(
				Type.Number({
					description:
						"For decide, fix-done, fix-skip and fix-answered: the [F#] number of the item, as review_see findings and review_draft fixes list them.",
				}),
			),
			settle: Type.Optional(
				Type.Union(
					[
						Type.Literal("promote"),
						Type.Literal("dismiss"),
						Type.Literal("fix"),
					],
					{
						description:
							"For decide: promote puts the finding into this draft as a remark, dismiss drops it, fix queues it as work to do rather than something to say. Pass body with promote to say it in your own words, or with fix to note how you mean to fix it.",
					},
				),
			),
		}),

		renderCall(args, theme) {
			const params = args as { action?: string; change?: string };
			return renderInvocation(
				theme,
				"review_draft",
				params.action,
				params.change,
			);
		},

		renderResult(result, _state, theme) {
			return renderAnswer(result, theme);
		},

		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Answer> {
			// Held outside the try so a failure can say which provider was asked.
			let bound: BoundTarget | undefined;
			try {
				const store = createDraftStore(draftDir());
				let draft: ReviewDraft;

				if (params.draft) {
					const resumed = await resumeDraft(params.draft, { store });
					if (!resumed) {
						return refuse(`There is no draft called ${params.draft}.`);
					}
					draft = resumed;
				} else {
					bound = await boundFor(pi, params, process.cwd());
					const { engine } = await reviewEngine(pi);
					draft = await engine.openDraft(bound.target);
				}

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
					const change = bound && hostedChange(bound);
					if (!bound || !change) {
						return refuse(
							"The fix queue belongs to a change, so name the change rather than a draft id.",
						);
					}
					return walkFixes(bound, change, params);
				}

				if (params.action === "publish-stack") {
					if (!bound) {
						return refuse(
							"Publishing a stack needs the target, so the stack can be read. Name a change in it rather than a draft id.",
						);
					}
					return publishStack(pi, bound, store, ctx);
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
					return say(
						`${GLYPH.finding} #${id} noted at ${anchorLabel(anchor)}`,
						{
							ok: true,
							item: id,
						},
					);
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
							"Reacting needs the change itself, so the comment can be found. Name the change rather than a draft id.",
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
							"Replying, resolving or reopening needs the change itself, so its threads can be read. Name the change rather than a draft id.",
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

				// Planning and publishing both need the provider's
				// capabilities, and the diff to judge anchors against.
				if (!bound) {
					return refuse(
						"Planning needs the target, so its provider's capabilities can be read. Name the change rather than a draft id.",
					);
				}
				const diff = await bound.diffModel().catch(() => undefined);
				const plan = draft.plan({
					capabilities: bound.capabilities,
					...(diff ? { diff } : {}),
				});

				if (params.action === "plan") {
					return say(planNarration(plan), {
						ok: true,
						ops: plan.ops.length,
						degraded: plan.degraded.length,
						refused: plan.refused.length,
					});
				}

				if (plan.ops.length === 0) {
					return refuse(
						"There is nothing in this draft that can be published. Plan it to see why.",
					);
				}
				// Before the gate, not after: the text about to go on
				// somebody else's change is mostly written by models, and
				// models emit emdashes and curly quotes by default.
				const prose = proseComplaint(plan);
				if (prose) return refuse(prose);

				const destination = `${hostedChange(bound)?.label ?? "this target"} \u00b7 ${bound.provider.id}`;
				const tabs = publishTabs(plan, destination, diff);
				const decision = await confirmBatch(
					ctx,
					"Publish This Review",
					tabs.map((tab) => tab.item),
				);
				if (!decision.proceed) {
					return decision.redirect
						? refuse(decision.redirect)
						: say("Left in the draft. Nothing was sent.");
				}

				// A tab is a draft item, not a request: rejecting one drops what
				// it came from and the plan is compiled again without it. That is
				// what makes the gate the last chance to drop a remark, rather
				// than something you run review_draft drop for beforehand and
				// then cannot see what you dropped.
				const dropped = tabs
					.filter((tab) => decision.rejected.includes(tab.item.label))
					.flatMap((tab) => tab.itemIds);
				let sending = plan;
				if (dropped.length > 0) {
					for (const id of dropped) await draft.remove(id);
					sending = draft.plan({
						capabilities: bound.capabilities,
						...(diff ? { diff } : {}),
					});
					if (sending.ops.length === 0) {
						return say(
							`${GLYPH.refused} everything in the draft was dropped at the gate. Nothing was sent.`,
						);
					}
				}
				const outcome = await draft.publish(sending, bound.provider);
				// Record where the change stood, so coming back to it later can say
				// whether it has moved. Recorded after publishing rather than
				// before: a review that failed to land is not a review of anything,
				// and claiming otherwise would mark work as seen that nobody said.
				if (outcome.ok) await noteVisit(bound);
				return say(outcomeNarration(outcome), {
					ok: outcome.ok,
					landed: outcome.outcomes.filter((entry) => entry.ok).length,
				});
			} catch (error) {
				return refuseFailure(error, bound);
			}
		},
	});
}

/**
 * Record that a review of this change landed, and where it stood.
 *
 * Quietly. A failure here loses a convenience and must not cost a review that
 * has already been posted: the remarks are on the change either way, and
 * throwing now would report a publish that worked as one that did not.
 */
async function noteVisit(bound: BoundTarget): Promise<void> {
	try {
		const change = hostedChange(bound);
		if (change === undefined) return;
		const proposal = await bound.proposal();
		if (!proposal) return;
		createVisitLog(visitDir()).record(change, {
			at: new Date().toISOString(),
			...(proposal.headCommit === undefined
				? {}
				: { commit: proposal.headCommit }),
		});
	} catch {
		// Nothing to do about it and nothing worth interrupting for. The next
		// visit simply reads as the first one.
	}
}

/**
 * Publish every draft in the stack, in the order the stack applies.
 *
 * A draft is about one change, so a review of a stack is several
 * drafts, and publishing them one at a time by hand loses the only
 * thing worth knowing afterwards: which changes now carry a review.
 *
 * Only changes that actually have a draft are published. A stack of
 * six where two drew remarks should send two reviews, not four empty
 * ones, and an empty review posted to a change nobody had anything to
 * say about is noise on somebody else's notifications.
 */
async function publishStack(
	pi: ExtensionAPI,
	bound: BoundTarget,
	store: DraftStore,
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
): Promise<Answer> {
	const stack = await bound.stack();
	if (!stack) {
		return refuse(
			`The ${bound.provider.id} provider does not read stacks, so there is no stack to publish across. Publish this one change with publish.`,
		);
	}

	const { engine } = await reviewEngine(pi);
	const entries: StackPublishEntry[] = [];
	const skipped: string[] = [];
	// Kept so the gate can show each remark against the code it points at,
	// using the diff already fetched to plan with rather than a second one.
	const diffs = new Map<string, DiffModel | undefined>();

	for (const node of stack.nodes) {
		if (node.proposal === undefined) continue;
		const change = node.proposal.ref;
		const target: ReviewTarget = { kind: "proposal", change };

		const held = await store.forTarget(target);
		if (held.length === 0) {
			skipped.push(node.ref);
			continue;
		}

		const one = await engine.openDraft(target);
		const at = await engine.bound(change);
		const diff = await at.diffModel().catch(() => undefined);
		const plan = one.plan({
			capabilities: at.capabilities,
			...(diff ? { diff } : {}),
		});
		if (plan.ops.length === 0) {
			skipped.push(node.ref);
			continue;
		}
		entries.push({ ref: node.ref, change, plan });
		diffs.set(node.ref, diff);
	}

	if (entries.length === 0) {
		return refuse(
			"No change in this stack has a draft with anything publishable in it. Plan one to see why.",
		);
	}

	// Every change, before any of them. Publishing across a stack is
	// sequential and keeps what landed, so letting the first two
	// through and refusing the third would leave a review half sent
	// over a habit that is the same in all three.
	for (const entry of entries) {
		const prose = proseComplaint(entry.plan);
		if (prose) return refuse(`${entry.ref}: ${prose}`);
	}

	// Grouped by change: every tab is prefixed with the ref it belongs to,
	// so a stack of three reviews reads as three groups rather than one
	// undifferentiated run of remarks.
	const grouped = entries.flatMap((entry) =>
		publishTabs(
			entry.plan,
			`${entry.change.label} \u00b7 ${bound.provider.id}`,
			diffs.get(entry.ref),
		).map((tab) => ({
			ref: entry.ref,
			tab: {
				...tab,
				item: { ...tab.item, label: `${entry.ref}:${tab.item.label}` },
			},
		})),
	);

	const decision = await confirmBatch(
		ctx,
		`Publish ${count(entries.length, "Review", "Reviews")} Across This Stack`,
		grouped.map((one) => one.tab.item),
	);
	if (!decision.proceed) {
		return decision.redirect
			? refuse(decision.redirect)
			: say("Left in the drafts. Nothing was sent.");
	}

	// Rejecting a change's Plan tab drops that whole change from the run.
	// Rejecting one of its other tabs is not honoured here, since the plans
	// were compiled against drafts this function does not hold open.
	const dropped = new Set(
		grouped
			.filter(
				(one) =>
					one.tab.item.label === `${one.ref}:${PLAN_TAB}` &&
					decision.rejected.includes(one.tab.item.label),
			)
			.map((one) => one.ref),
	);
	const sending = entries.filter((entry) => !dropped.has(entry.ref));
	if (sending.length === 0) {
		return say("Every change was dropped at the gate. Nothing was sent.");
	}

	const outcome = await publishAcross(sending, bound.provider);
	return say(
		[
			...outcome.changes.map(
				(one) => `${one.ref}: ${outcomeNarration(one.outcome)}`,
			),
			...(skipped.length === 0
				? []
				: [
						`\nNothing to say about ${skipped.join(", ")}, so nothing was sent there.`,
					]),
			...(outcome.remaining.length === 0
				? []
				: [
						`\nStill unsent: ${outcome.remaining.join(", ")}. Publishing again sends only those, since what landed is kept out of the drafts.`,
					]),
		].join("\n"),
		{
			ok: outcome.ok,
			landed: outcome.landed,
			remaining: outcome.remaining,
			skipped,
		},
	);
}

/**
 * Walk the findings queued to fix rather than to say.
 *
 * The walk hands back one finding and stops. Editing, checking and
 * committing happen in the caller's own loop, where a person can
 * interrupt with a sentence at any point, and only then does the
 * outcome get recorded. A queue that applied its own fixes would be a
 * queue nobody could stop halfway, which is the opposite of what
 * anybody wants from a list of changes to their own code.
 */
async function walkFixes(
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	params: {
		action: string;
		finding?: number;
		body?: string;
		commit?: string;
	},
): Promise<Answer> {
	const queue = createFixQueue(fixDir());

	if (params.action === "fixes") {
		const held = await queue.list(change);
		if (held.length === 0) {
			return say(`Nothing is queued to fix on ${change.label}.`);
		}
		return say(
			held
				.map((one) => {
					const mark =
						one.outcome === undefined
							? GLYPH.unresolved
							: one.outcome.kind === "committed"
								? GLYPH.resolved
								: GLYPH.refused;
					const tail =
						one.outcome?.kind === "committed"
							? ` (${one.outcome.commit})`
							: one.outcome?.kind === "skipped"
								? ` (skipped: ${one.outcome.reason})`
								: one.outcome?.kind === "answered"
									? " (answered)"
									: "";
					return `${mark} F${one.findingId} ${describeSubject(one)}${tail}`;
				})
				.join("\n"),
			{ ok: true, ...(await queue.tally(change)) },
		);
	}

	if (params.action === "fix-next") {
		const held = await queue.next(change);
		if (held === undefined) {
			const tally = await queue.tally(change);
			return say(
				tally.committed + tally.skipped + tally.answered === 0
					? `Nothing is queued to fix on ${change.label}.`
					: `Every queued item on ${change.label} is settled: ${tally.committed} committed, ${tally.skipped} skipped, ${tally.answered} answered.`,
				{ ok: true, ...tally },
			);
		}
		// Handed a tree along with the item, because being told what to
		// fix and left to find somewhere to fix it is the last mile
		// nobody walks. One tree serves the whole change: a worktree's
		// identity is its repo and branch, so the second item resolves to
		// the same directory as the first.
		// The head branch, from the provider rather than from the ref: a
		// reference carries a label, and a label is not something you can
		// check out.
		const proposal = await bound.proposal();
		const where =
			proposal === null
				? {
						refusal: `The ${bound.provider.id} provider does not report this change's head branch, so there is nothing to check a tree out at.`,
					}
				: await treeForFixing(bound.repo, proposal.head);
		const somewhere =
			"refusal" in where
				? ["", `Nowhere to work: ${where.refusal}`]
				: ["", `Fix it in ${displayPath(where.path)}.`];

		// What to say next depends on which kind it is, and this is the
		// place that difference is felt: a finding is closed by a commit,
		// while somebody's remark is not dealt with until they have been
		// answered, whether or not the code changed.
		const subject = subjectOf(held);
		const body =
			subject?.kind === "thread"
				? [
						`${GLYPH.thread} F${held.findingId} ${describeSubject(held)}`,
						"",
						...(held.note === undefined
							? []
							: [`How you meant to: ${held.note}`, ""]),
						"Answer it with review_say reply, then record it: fix-done with the commit when the code changed, or fix-answered when the reply was the whole of it.",
					]
				: [
						`${GLYPH.finding} F${held.findingId} ${describeSubject(held)}`,
						...(subject === undefined
							? []
							: [
									`   ${anchorLabel(subject.finding.anchor)}`,
									"",
									subject.finding.discussion,
								]),
						...(held.note === undefined
							? []
							: ["", `How you meant to: ${held.note}`]),
						"",
						"Fix it in your own loop, then record it with fix-done and the commit, or drop it with fix-skip and a reason.",
					];
		return say([...body, ...somewhere].join("\n"), {
			ok: true,
			finding: held.findingId,
			...("refusal" in where ? {} : { tree: where.path }),
		});
	}

	if (params.action === "take-threads") {
		// The morning-after journey, in one call. Sweeping every
		// unresolved thread onto the worklist is what a person does by
		// hand otherwise, and doing it by hand is how one gets missed.
		const threads = await bound.provider.conversation?.threads(change);
		if (threads === undefined) {
			return refuse(
				`The ${bound.provider.id} provider does not read conversation, so there are no threads here to take.`,
			);
		}
		const taken: string[] = [];
		let already = 0;
		for (const thread of threads.filter((one: Thread) => !one.resolved)) {
			const opener = thread.comments[0];
			try {
				const id = await queue.queueThread(change, {
					id: thread.id,
					...(opener?.author?.name === undefined
						? {}
						: { author: opener.author.name }),
					...(thread.anchor === undefined
						? {}
						: { where: anchorLabel(thread.anchor) }),
					said: opener?.body ?? "",
				});
				taken.push(
					`   ${GLYPH.thread} F${id} ${opener?.author?.name ?? "somebody"}`,
				);
			} catch {
				// Already on the list. Sweeping twice is the normal case, not
				// an error: a person runs this again after replying to some.
				already += 1;
			}
		}
		const tally = await queue.tally(change);
		return say(
			[
				taken.length === 0
					? `Nothing new to take on ${change.label}: ${already} unresolved ${already === 1 ? "thread is" : "threads are"} already on the worklist.`
					: `${GLYPH.thread} Took ${count(taken.length, "thread", "threads")} onto the worklist for ${change.label}.`,
				...taken,
				...(already === 0 || taken.length === 0
					? []
					: [`   ${already} were already there.`]),
			].join("\n"),
			{ ok: true, taken: taken.length, ...tally },
		);
	}

	if (params.finding === undefined) {
		return refuse(
			"Recording against a fix needs the item's number. review_draft fixes lists them.",
		);
	}

	if (params.action === "fix-answered") {
		if (!params.body) {
			return refuse(
				"Recording an item as answered needs what you said, so the worklist reads back as a record of the conversation rather than a list of ticks.",
			);
		}
		await queue.record(change, params.finding, {
			kind: "answered",
			reply: params.body,
		});
		const tally = await queue.tally(change);
		return say(
			`${GLYPH.thread} F${params.finding} answered. ${tally.pending} left.`,
			{ ok: true, ...tally },
		);
	}

	if (params.action === "fix-done") {
		if (!params.commit) {
			// The commit is the evidence. Recording a fix as done without
			// one leaves a claim nobody can check against the history.
			return refuse(
				"Recording a fix as done needs the commit it landed in, which is what makes the claim checkable later.",
			);
		}
		await queue.record(change, params.finding, {
			kind: "committed",
			commit: params.commit,
		});
		const tally = await queue.tally(change);
		return say(
			`${GLYPH.lands} F${params.finding} fixed in ${params.commit}. ${tally.pending} left.`,
			{ ok: true, ...tally },
		);
	}

	if (!params.body) {
		// A skip with no reason is indistinguishable from forgetting,
		// and the queue keeps skips precisely so they can be read back.
		return refuse(
			"Dropping a queued fix needs a reason, since the queue keeps it: a skip with no reason reads the same as forgetting.",
		);
	}
	await queue.record(change, params.finding, {
		kind: "skipped",
		reason: params.body,
	});
	const tally = await queue.tally(change);
	return say(
		`${GLYPH.refused} F${params.finding} dropped: ${params.body}. ${tally.pending} left.`,
		{ ok: true, ...tally },
	);
}

/**
 * Settle one produced finding into the review, or drop it.
 *
 * This is the seam between what something raised and what you are
 * willing to say. A finding is nobody's business until it is
 * promoted, which is why promoting copies it into the draft as a
 * remark rather than the conversation reading findings directly.
 *
 * Promoting takes the finding's own words unless you supply
 * better ones, because the common case is agreeing with a finding
 * and the uncommon case is agreeing with a qualification.
 */
async function decideFinding(
	bound: BoundTarget | undefined,
	draft: ReviewDraft,
	params: {
		finding?: number;
		settle?: "promote" | "dismiss" | "fix";
		body?: string;
	},
): Promise<Answer> {
	if (params.finding === undefined || params.settle === undefined) {
		return refuse(
			"Deciding needs the finding's number and what to do with it: promote it into the draft, dismiss it, or queue it to fix.",
		);
	}
	if (!bound) {
		return refuse(
			"A resumed draft does not know which change its findings were raised against. Name the change on this call.",
		);
	}
	const change = hostedChange(bound);
	if (!change) {
		return refuse(
			`A ${bound.target.kind} in ${bound.repo.key} holds no findings, since there is no change to hold them on.`,
		);
	}
	const store = createFindingStore(findingDir());
	const findings = await store.list(change);
	const finding = findings.find((held) => held.id === params.finding);
	if (!finding) {
		return refuse(
			findings.length === 0
				? `Nothing has been raised on ${change.label}, so there is no F${params.finding} to decide.`
				: `There is no F${params.finding} on ${change.label}. Read review_see findings; the listing numbers them.`,
		);
	}

	if (params.settle === "dismiss") {
		// Recorded, or the findings listing reads the same before and
		// after: a dismissal leaves no other trace anywhere.
		await createDecisionLedger(decisionDir()).record(
			change,
			finding.id,
			"dismiss",
			params.body,
		);
		return say(
			`${GLYPH.refused} F${finding.id} dismissed, and left out of the draft.\n   ${finding.subject}`,
			{ ok: true, finding: finding.id, settled: "dismiss" },
		);
	}

	if (params.settle === "fix") {
		// Not into the draft. A finding you agree with on your own change
		// is work rather than a remark, and posting it would be telling
		// yourself something you already know.
		await createFixQueue(fixDir()).queue(
			change,
			finding,
			...(params.body === undefined ? [] : [params.body]),
		);
		await createDecisionLedger(decisionDir()).record(
			change,
			finding.id,
			"fix",
			params.body,
		);
		const tally = await createFixQueue(fixDir()).tally(change);
		return say(
			[
				`${GLYPH.finding} F${finding.id} queued to fix, not to say.`,
				`   ${finding.subject}`,
				`   ${tally.pending} waiting. review_draft fix-next takes the first.`,
			].join("\n"),
			{ ok: true, finding: finding.id, settled: "fix", pending: tally.pending },
		);
	}

	const body = params.body ?? `${finding.subject}\n\n${finding.discussion}`;
	const id = await draft.addFinding({ anchor: finding.anchor, body });
	await createDecisionLedger(decisionDir()).record(
		change,
		finding.id,
		"promote",
		params.body,
	);
	return say(
		`${GLYPH.finding} F${finding.id} promoted into draft ${draft.id} as #${id}, at ${anchorLabel(finding.anchor)}${params.body ? "\n   in your words rather than its own" : ""}`,
		{ ok: true, finding: finding.id, item: id, settled: "promote" },
	);
}
