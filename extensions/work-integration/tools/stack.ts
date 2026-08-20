/**
 * The stack verbs, and how a stack reads.
 *
 * Kept apart from the tree verbs because they answer a different question. A
 * tree is a place; a stack is a shape, and the shape is the thing that has no
 * representation in git and therefore needs saying out loud. A listing that
 * only names branches has not helped: what a person needs to see is what sits
 * on what, and which of them is no longer aligned with the branch under it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	orderStack,
	type ReplayResult,
	type StackedBranch,
	type WorkStacks,
} from "@jitsusama/agentic-harness.core/work";
import { GLYPH } from "../render.js";
import { type Answer, refuse, say } from "./shared.js";

/** How far in a branch sits, so the shape is visible at a glance. */
const STEP = "  ";

/**
 * A stack, drawn as the shape it is.
 *
 * Indentation carries parentage, because that is the one fact a flat list of
 * branch names throws away. The branch checked out right now is filled and the
 * rest are hollow, matching what a filled square already means on this surface:
 * the one you are in, rather than one merely named.
 */
export function stackLines(
	branches: readonly StackedBranch[],
	options: {
		on?: string;
		trunk?: string;
		drifted?: readonly string[];
		undecided?: readonly string[];
	} = {},
): string[] {
	const order = orderStack(branches);
	if (order.kind === "faulted") {
		return [`${GLYPH.refused} ${order.fault.reason}`];
	}

	const depthOf = new Map<string, number>();
	const lines: string[] = [];
	for (const branch of order.branches) {
		const depth =
			branch.parent === undefined ? 0 : (depthOf.get(branch.parent) ?? 0) + 1;
		depthOf.set(branch.name, depth);
		const here = branch.name === options.on;
		const notes = [
			branch.parent === undefined
				? options.trunk === undefined
					? undefined
					: `on ${options.trunk}`
				: undefined,
			options.drifted?.includes(branch.name) ? "needs replaying" : undefined,
			// Undecided is not aligned. A branch nothing could judge, most often a
			// root with no trunk named, drew exactly like one known to be in place,
			// and that silence is how somebody trusts a stale stack. The shape verbs
			// have said this since they were written; the listing, which is where a
			// person actually looks at the whole thing, could not say it at all.
			options.undecided?.includes(branch.name)
				? "alignment unknown"
				: undefined,
			here ? "you are here" : undefined,
		].filter((note) => note !== undefined);
		lines.push(
			`${STEP.repeat(depth)}${here ? GLYPH.tree : GLYPH.named} ${branch.name}${
				notes.length > 0 ? ` · ${notes.join(" · ")}` : ""
			}`,
		);
	}
	return lines;
}

/** One replay's outcome, as a line under a restack. */
function replayLine(result: ReplayResult): string {
	const said: Record<ReplayResult["outcome"], string> = {
		replayed: `replayed onto ${result.onto}`,
		"already-there": "already in place",
		halted: "halted",
		skipped: "not reached",
	};
	const mark =
		result.outcome === "halted"
			? GLYPH.refused
			: result.outcome === "skipped"
				? GLYPH.named
				: GLYPH.tree;
	return `   ${mark} ${result.branch} · ${said[result.outcome]}`;
}

/** Run one stack verb against a held tree. */
export async function runStackAction(
	_pi: ExtensionAPI,
	stacks: WorkStacks,
	tree: { path: string; identity: { key: string } },
	action:
		| "stack"
		| "track"
		| "untrack"
		| "reparent"
		| "reorder"
		| "restack"
		| "sync",
	args: {
		name?: string;
		onto?: string;
		order?: readonly string[];
		trunk?: string;
		on?: string;
	},
): Promise<Answer> {
	if (action === "stack") {
		const held = await stacks.read(tree.path);
		if (held.length === 0) {
			return say(
				[
					`${GLYPH.stack} Nothing in ${tree.identity.key} is tracked as a stack.`,
					"",
					"Track a branch against what it sits on and it will appear here. A branch tracked with no parent is a root, sitting on trunk.",
				].join("\n"),
				{ ok: true, branches: [] },
			);
		}
		// Whether each branch still sits on the one under it. The renderer has been
		// able to say "needs replaying" since it was written and never once said it,
		// because nothing computed the answer: a decoration with no supplier, which
		// reads as a clean stack rather than as an unasked question. It is the one
		// fact a listing of names cannot carry and the reason to draw a stack at all.
		const standing = await stacks.drifted(
			tree.path,
			args.trunk === undefined ? undefined : args.trunk,
		);
		return say(
			[
				`${GLYPH.stack} ${held.length} ${held.length === 1 ? "branch" : "branches"} in ${tree.identity.key}`,
				...stackLines(held, {
					...(args.on === undefined ? {} : { on: args.on }),
					...(args.trunk === undefined ? {} : { trunk: args.trunk }),
					drifted: standing.drifted,
					undecided: standing.undecided,
				}),
				...(standing.drifted.length > 0
					? [
							"",
							`Restack to replay ${standing.drifted.length === 1 ? "it" : "them"} onto what ${standing.drifted.length === 1 ? "it sits" : "they sit"} on.`,
						]
					: []),
				...(standing.undecided.length > 0 && args.trunk === undefined
					? [
							"",
							"Name trunk to judge the roots. Without it there is nothing to compare them against.",
						]
					: []),
			].join("\n"),
			{
				ok: true,
				branches: held,
				drifted: standing.drifted,
				undecided: standing.undecided,
			},
		);
	}

	if (action === "track" || action === "untrack") {
		if (!args.name) {
			return refuse(
				`${GLYPH.refused} Name the branch to ${action}, with name.`,
			);
		}
		const outcome =
			action === "track"
				? await stacks.track(
						tree.path,
						args.name,
						args.onto === undefined ? undefined : args.onto,
					)
				: await stacks.untrack(tree.path, args.name);
		// Read after the change, so the note describes the stack the caller now has.
		// Every verb here moves the record and no commits, so every one of them can
		// leave the two disagreeing, and untrack does it at one remove: whatever sat
		// on the forgotten branch moves down onto its parent without being replayed.
		const standing = await stacks.drifted(
			tree.path,
			args.trunk === undefined ? undefined : args.trunk,
		);
		return shaped(outcome, action, args.name, args.onto, standing);
	}

	if (action === "reparent") {
		if (!args.name) {
			return refuse(`${GLYPH.refused} Name the branch to move, with name.`);
		}
		const outcome = await stacks.reparent(
			tree.path,
			args.name,
			args.onto === undefined ? undefined : args.onto,
		);
		const standing = await stacks.drifted(
			tree.path,
			args.trunk === undefined ? undefined : args.trunk,
		);
		return shaped(outcome, action, args.name, args.onto, standing);
	}

	if (action === "reorder") {
		if (!args.order || args.order.length === 0) {
			return refuse(
				`${GLYPH.refused} Say the order you want, lowest branch first, with order. Nothing here can work out an order you have not stated.`,
			);
		}
		const outcome = await stacks.reorder(tree.path, args.order);
		if (outcome.kind === "shaped") {
			const held = await stacks.read(tree.path);
			// The record moved; the commits have not. This used to be said
			// unconditionally, which cries wolf on the reorder that needs no replay,
			// and said nothing about which branches were affected. Computed now, and
			// shared with the other shape verbs so the four cannot drift apart.
			const standing = await stacks.drifted(
				tree.path,
				args.trunk === undefined ? undefined : args.trunk,
			);
			return say(
				[
					`${GLYPH.stack} Reordered. ${outcome.changed.length} ${outcome.changed.length === 1 ? "branch" : "branches"} now sit somewhere new.`,
					...stackLines(held, {
						...(args.on === undefined ? {} : { on: args.on }),
						drifted: standing.drifted,
					}),
					...alignmentNote(standing),
				].join("\n"),
				{ ok: true, changed: outcome.changed, drifted: standing.drifted },
			);
		}
		return shaped(outcome, action, args.order.join(", "), undefined);
	}

	const trunk = args.trunk;
	if (trunk === undefined) {
		return refuse(
			`${GLYPH.refused} Say what the bottom of the stack sits on, with trunk. A ${action} replays every tracked branch, and guessing the base would rewrite all of them onto the wrong thing.`,
		);
	}

	let fetched: string | undefined;
	let outcome: Awaited<ReturnType<typeof stacks.restack>>;
	if (action === "sync") {
		const synced = await stacks.sync(tree.path, trunk);
		if (synced.kind === "refused") {
			return refuse(`${GLYPH.refused} ${synced.reason}`);
		}
		// Whether the fetch moved anything is worth saying either way: an
		// unchanged trunk explains why nothing needed replaying, and a moved one
		// explains why everything did.
		fetched = synced.moved
			? `${trunk} moved, so the stack needed replaying.`
			: `${trunk} was already up to date.`;
		outcome = synced.replay;
	} else {
		outcome = await stacks.restack(tree.path, trunk);
	}
	if (outcome.kind === "refused") {
		return refuse(`${GLYPH.refused} ${outcome.reason}`);
	}
	if (outcome.kind === "faulted") {
		return refuse(`${GLYPH.refused} ${outcome.fault.reason}`);
	}
	if (outcome.kind === "halted") {
		return refuse(
			[
				...(fetched === undefined ? [] : [`${GLYPH.stack} ${fetched}`, ""]),
				`${GLYPH.refused} Restack halted at ${outcome.at}.`,
				...outcome.results.map(replayLine),
				"",
				...outcome.conflicted.map((path) => `   ${GLYPH.dirty} ${path}`),
				"",
				"Settle those, then resume, and restack again to carry on up the stack. Or abandon, and nothing above this moves.",
			].join("\n"),
		);
	}
	const moved = outcome.results.filter(
		(result) => result.outcome === "replayed",
	).length;
	return say(
		[
			...(fetched === undefined ? [] : [`${GLYPH.stack} ${fetched}`]),
			moved === 0
				? `${GLYPH.clean} Every branch was already in place. Nothing to replay.`
				: `${GLYPH.stack} Restacked ${moved} of ${outcome.results.length} onto ${trunk}.`,
			...outcome.results.map(replayLine),
			...(outcome.on === undefined ? [] : ["", `Back on ${outcome.on}.`]),
		].join("\n"),
		{ ok: true, replayed: moved },
	);
}

/** A shape change, or the reason there was not one. */
/**
 * What a shape change left out of step, said in one sentence.
 *
 * Every verb here records where a branch should sit without moving any commits, so
 * every one of them can leave the record and the commits disagreeing. Only reorder
 * used to mention it, and it mentioned it unconditionally, which is a warning that
 * cries wolf on the reorder that happens to need no replay at all. Now the answer
 * is computed, so it can name the branches and be believed.
 *
 * Silent when nothing could be judged, because a root cannot be judged without a
 * trunk to judge it against, and "nothing to do" is not a thing to say when the
 * question was never answered.
 */
export function alignmentNote(standing: {
	drifted: readonly string[];
	undecided: readonly string[];
}): string[] {
	if (standing.drifted.length > 0) {
		return [
			"",
			`The record says this now, but ${standing.drifted.join(", ")} ${standing.drifted.length === 1 ? "is" : "are"} not sitting on ${standing.drifted.length === 1 ? "its" : "their"} parent yet. Restack to make the commits match.`,
		];
	}
	if (standing.undecided.length > 0) return [];
	return ["", "The commits already match, so there is nothing to replay."];
}

function shaped(
	outcome:
		| { kind: "shaped"; changed: readonly string[] }
		| { kind: "unchanged" }
		| { kind: "faulted"; fault: { reason: string } }
		| { kind: "refused"; reason: string },
	action: string,
	what: string,
	onto: string | undefined,
	standing?: { drifted: readonly string[]; undecided: readonly string[] },
): Answer {
	if (outcome.kind === "refused") {
		return refuse(`${GLYPH.refused} ${outcome.reason}`);
	}
	if (outcome.kind === "faulted") {
		return refuse(`${GLYPH.refused} ${outcome.fault.reason}`);
	}
	if (outcome.kind === "unchanged") {
		return say(`${GLYPH.clean} ${what} already sits there. Nothing changed.`, {
			ok: true,
			changed: [],
		});
	}
	const where =
		action === "untrack"
			? "no longer tracked"
			: onto === undefined
				? "tracked as a root, sitting on trunk"
				: `sitting on ${onto}`;
	const also = outcome.changed.filter((one) => one !== what);
	return say(
		[
			`${GLYPH.stack} ${what} is ${where}.`,
			...(also.length > 0
				? [`   ${also.join(", ")} moved down to keep the stack whole.`]
				: []),
			...(standing === undefined ? [] : alignmentNote(standing)),
		].join("\n"),
		{
			ok: true,
			changed: outcome.changed,
			...(standing === undefined ? {} : { drifted: standing.drifted }),
		},
	);
}
