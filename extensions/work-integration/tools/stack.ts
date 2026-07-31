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
} from "../../../lib/work/index.js";
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
	options: { on?: string; trunk?: string; drifted?: readonly string[] } = {},
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
	action: "stack" | "track" | "untrack" | "reparent" | "reorder" | "restack",
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
		return say(
			[
				`${GLYPH.stack} ${held.length} ${held.length === 1 ? "branch" : "branches"} in ${tree.identity.key}`,
				...stackLines(held, {
					...(args.on === undefined ? {} : { on: args.on }),
					...(args.trunk === undefined ? {} : { trunk: args.trunk }),
				}),
			].join("\n"),
			{ ok: true, branches: held },
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
		return shaped(outcome, action, args.name, args.onto);
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
		return shaped(outcome, action, args.name, args.onto);
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
			return say(
				[
					`${GLYPH.stack} Reordered. ${outcome.changed.length} ${outcome.changed.length === 1 ? "branch" : "branches"} now sit somewhere new.`,
					...stackLines(held, args.on === undefined ? {} : { on: args.on }),
					"",
					// The record moved; the commits have not. Saying so is the
					// difference between a reorder somebody finishes and one
					// they believe is already done.
					"The record says this now, but nothing has been replayed yet. Restack to make the commits match.",
				].join("\n"),
				{ ok: true, changed: outcome.changed },
			);
		}
		return shaped(outcome, action, args.order.join(", "), undefined);
	}

	const trunk = args.trunk;
	if (trunk === undefined) {
		return refuse(
			`${GLYPH.refused} Say what the bottom of the stack sits on, with trunk. A restack replays every tracked branch, and guessing the base would rewrite all of them onto the wrong thing.`,
		);
	}
	const outcome = await stacks.restack(tree.path, trunk);
	if (outcome.kind === "refused") {
		return refuse(`${GLYPH.refused} ${outcome.reason}`);
	}
	if (outcome.kind === "faulted") {
		return refuse(`${GLYPH.refused} ${outcome.fault.reason}`);
	}
	if (outcome.kind === "halted") {
		return refuse(
			[
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
function shaped(
	outcome:
		| { kind: "shaped"; changed: readonly string[] }
		| { kind: "unchanged" }
		| { kind: "faulted"; fault: { reason: string } }
		| { kind: "refused"; reason: string },
	action: string,
	what: string,
	onto: string | undefined,
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
		].join("\n"),
		{ ok: true, changed: outcome.changed },
	);
}
