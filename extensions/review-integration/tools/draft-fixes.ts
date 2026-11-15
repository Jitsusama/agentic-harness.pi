/**
 * The `review_draft` fix queue: walking the findings and threads queued
 * to fix rather than to say, one at a time, and recording how each was
 * settled.
 *
 * Apart from `draft.ts` because it changes with how work on your own
 * change is handed out and recorded, which has nothing to do with what
 * a review will say on somebody else's.
 */

import {
	type BoundTarget,
	createFixQueue,
	describeSubject,
	subjectOf,
	type Thread,
} from "../../../lib/core/review/index.ts";
import { count } from "../../../lib/ui/count.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { fixDir } from "../engine.ts";
import { anchorLabel, GLYPH } from "../render.ts";
import { treeForFixing } from "../work.ts";
import { type Answer, hostedChange, refuse, say } from "./shared.ts";

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
export async function walkFixes(
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
		if (!hostedChange(bound)) {
			return refuse(
				`Nothing hosts ${change.label}, so there are no threads on it to take.`,
			);
		}
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
