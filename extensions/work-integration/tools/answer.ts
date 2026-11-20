/**
 * One call of `work`, answered: the verbs that need no held tree first,
 * then the gate that settles which held tree the rest act on, then the
 * verb itself, each in the file that owns it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createGitHistory } from "../../../lib/core/work/history.ts";
import { chooseTree, treeInPlay } from "../../../lib/core/work/inplay.ts";
import { createGitRebaser } from "../../../lib/core/work/rebase.ts";
import { createGitStacks } from "../../../lib/core/work/stacks.ts";
import { heldNames } from "../../../lib/core/work/survey.ts";
import { unattendedExec } from "../../../lib/internal/sandbox/unattended-exec.ts";
import { treeBroker } from "../broker.ts";
import { GLYPH } from "../render.ts";
import { makeBranch, record } from "./author.ts";
import { carryHome } from "./carry.ts";
import { cutTree } from "./cut.ts";
import { claimedTree, heldByName } from "./held.ts";
import { datedHeld, listHeld, releaseTree } from "./listing.ts";
import { publish } from "./push.ts";
import { replay } from "./replay.ts";
import { type Answer, messageOf, refuse } from "./shared.ts";
import { runStackAction } from "./stack.ts";
import { statusOf } from "./status.ts";
import { survey } from "./survey.ts";

/** What `work` was asked, as pi hands it over. */
export interface WorkArgs {
	action?:
		| "tree"
		| "snapshot"
		| "trees"
		| "release"
		| "status"
		| "tidy"
		| "reclaim"
		| "record"
		| "branch"
		| "push"
		| "carry"
		| "rebase"
		| "resume"
		| "abandon"
		| "stack"
		| "track"
		| "untrack"
		| "reparent"
		| "reorder"
		| "restack"
		| "sync";
	repo?: string;
	checkout?: string;
	remote?: string;
	purpose?: string;
	branch?: string;
	commit?: string;
	paths?: string[];
	tree?: string;
	subject?: string;
	body?: string;
	name?: string;
	from?: string;
	onto?: string;
	replace?: boolean;
	trunk?: string;
	order?: string[];
}

/** Answer one call of `work`, under the signal that may stop it. */
export async function answerWork(
	pi: ExtensionAPI,
	args: WorkArgs,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<Answer> {
	const action = args.action ?? "trees";
	const broker = treeBroker();
	// Built once per call and carrying the caller's signal, so pressing
	// escape reaches the git child rather than only the promise waiting on
	// it. Without it a blocked command outlives the request that started
	// it, which is how a hung rebase became unstoppable. Unattended, so
	// a credential or passphrase prompt fails rather than being drawn
	// over pi's interface.
	const exec = unattendedExec(signal);

	try {
		if (action === "trees") return await listHeld(broker, ctx);
		if (action === "tree" || action === "snapshot") {
			return await cutTree(exec, broker, action, args, ctx, signal);
		}
		if (action === "tidy" || action === "reclaim") {
			return await survey(pi, exec, broker, action, args, ctx, signal);
		}

		const held = broker.held();
		// A session holding one tree should not have to name it fifteen times.
		// Several stay a question rather than resolving by recency, which is
		// where this parts company with the change version: these actions
		// commit, push and replay, and nothing here states which tree you
		// meant the way attaching a change does.
		const inPlay = treeInPlay(
			args.tree,
			held.map((h) => h.identity.key),
		);
		if ("candidates" in inPlay) {
			return refuse(`${GLYPH.refused} ${chooseTree(inPlay.candidates)}`);
		}
		// Dated as an ask, since a tree named here is read by path after,
		// as one listed is. Only this session's own: dating holds a tree,
		// and another session's or a quest's is theirs to hold.
		const named = heldByName(held, inPlay.key);
		if (
			named !== undefined &&
			(await datedHeld(broker, [named])).length === 0
		) {
			return refuse(
				`${GLYPH.refused} ${inPlay.key} isn't where it was: a sweep may have taken it after it went unused. Ask for it again with action 'tree' or 'snapshot', which finds it if it stands.`,
			);
		}
		const found = named ?? (await claimedTree(pi, inPlay.key));
		if (!found) {
			// Naming what is held turns a typo into a correction
			// rather than a second guess.
			const names = heldNames(
				held.map((h) => ({ key: h.identity.key })),
				inPlay.key,
			);
			return refuse(
				`${GLYPH.refused} No held tree called ${inPlay.key}: ${names}.`,
			);
		}

		const history = createGitHistory({ exec });

		switch (action) {
			case "record":
				return await record(pi, ctx, exec, history, found, args);
			case "branch":
				return await makeBranch(exec, history, found, args, signal);
			case "carry":
				return await carryHome(exec, found, ctx.sessionManager);
			case "push":
				return await publish(pi, exec, history, found, args.replace);
			case "rebase":
			case "resume":
			case "abandon":
				return await replay(exec, found, action, args.onto, signal);
			case "stack":
			case "track":
			case "untrack":
			case "reparent":
			case "reorder":
			case "restack":
			case "sync": {
				// Already built above with the caller's signal on it.
				const stacks = createGitStacks({
					exec,
					rebaser: createGitRebaser({ exec }),
				});
				// Which branch is checked out is what marks "you are here" in a
				// listing, and a stack you cannot locate yourself in is a
				// diagram rather than a tool.
				const head = await history.head(found.path);
				return await runStackAction(pi, stacks, found, action, {
					...(args.name === undefined ? {} : { name: args.name }),
					...(args.onto === undefined ? {} : { onto: args.onto }),
					...(args.order === undefined ? {} : { order: args.order }),
					...(args.trunk === undefined ? {} : { trunk: args.trunk }),
					...(head.branch === undefined ? {} : { on: head.branch }),
				});
			}
			case "status":
				return await statusOf(history, found, ctx);
			default:
				return await releaseTree(broker, history, found, signal);
		}
	} catch (error) {
		return refuse(`${GLYPH.refused} ${messageOf(error)}`);
	}
}
