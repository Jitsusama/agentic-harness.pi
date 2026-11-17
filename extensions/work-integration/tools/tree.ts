/**
 * The `work` tool: trees to work in, and what is in them.
 *
 * `lib/work` has answered the trees question for a while with
 * nothing on top of it, which meant the whole layer was reachable
 * only from tests. This is the surface: cut a tree, pin a
 * snapshot, list what is held, give one back, and read the state
 * of the work inside one.
 *
 * Committing and branching arrived once `lib/work` had primitives
 * for them, which is the order that keeps a tool action from being
 * a promise the surface cannot keep.
 *
 * This file is the tool's schema and its handoff to a job; `answer.ts`
 * routes each call to the file that owns its verb.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { withCallSignal } from "../../../lib/core/exec/index.ts";
import { sessionKeyOf } from "../../../lib/core/session/index.ts";
import {
	endsWithItsPrompts,
	runOrHandOff,
} from "../../../lib/jobs/hand-off.ts";
import { answerWork, type WorkArgs } from "./answer.ts";
import { type Answer, renderAnswer, renderInvocation } from "./shared.ts";

/** What the work tool does, one action a call. */
const WORK_ACTIONS = [
	"tree",
	"snapshot",
	"trees",
	"release",
	"status",
	"tidy",
	"reclaim",
	"record",
	"branch",
	"push",
	"carry",
	"rebase",
	"resume",
	"abandon",
	"stack",
	"track",
	"untrack",
	"reparent",
	"reorder",
	"restack",
	"sync",
] as const;

/**
 * The longest commit subject core's commit format accepts, and a length
 * to aim for below it. Said in the subject's description because the
 * refusal was the only place it was said: the subjects refused ran
 * mostly 51 to 53 characters, written to a limit the writer was guessing
 * at, and each refusal cost a turn.
 */
export const SUBJECT_LIMIT = 50;
const SUBJECT_AIM = 40;

/** Register the `work` tool. */
export function registerWorkTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "work",
		label: "Work",
		description:
			"Get somewhere to work and know what is in it: cut a worktree at a branch, pin a snapshot at a commit, list the trees this session holds, give one back, or read what has changed inside one. Call with no action to list what is held.",
		promptSnippet:
			"Somewhere to work: tree, snapshot, trees, release, status, tidy.",
		// A batch holding a work call then runs one call at a time, in the order
		// written. Side by side, a resume read the tree before the `git add` beside
		// it, and a branch before the `git revert --abort` beside it, and both
		// reported a halt or failure that was gone by the time anyone looked.
		executionMode: "sequential",
		promptGuidelines: [
			"A worktree is checked out at a branch and is yours alone; a snapshot is pinned to a commit and may be shared with another reader. Ask for the one that matches what you are about to do.",
			"Always say what the tree is for. The purpose names it, which is how it is recognised later and how a second caller avoids cutting a duplicate.",
			"Read status before repointing or discarding a tree. An untracked file is work, and overwriting one cannot be undone.",
			"Never call git worktree yourself. A tree cut outside the broker is one nothing will clean up.",
			"A push, rebase, resume, restack or sync still running after a minute moves to the background, its result arriving later as a message of its own; do not repeat it, or change that tree, until then.",
		],
		parameters: Type.Object({
			// An enum rather than a union of literals: the same choices, said in
			// a third of the characters every session sends every turn.
			action: Type.Optional(
				StringEnum(WORK_ACTIONS, {
					description:
						"tree: cut a worktree at a branch; snapshot: pin one at a commit; trees: list what is held (the default); release: give one back; status: what changed in it. tidy: report what is spent, removing nothing; reclaim: take back the unowned trees tidy found. record: stage and commit; branch: make and check out a branch; push: publish it; carry: bundle what a leaving machine can't push into the quest's scratch handover/. rebase onto a ref, halting on a conflict; resume or abandon a halted one. stack: what sits on what; track, untrack, reparent and reorder (lowest first) shape it; restack replays it onto trunk; sync fetches trunk first.",
				}),
			),
			repo: Type.Optional(
				Type.String({
					description:
						"Repo key, e.g. github:Shopify/world. Needed for tree and snapshot.",
				}),
			),
			checkout: Type.Optional(
				Type.String({
					description:
						"For tree and snapshot: a local checkout to cut from. Much cheaper than a remote, and required unless a remote is given.",
				}),
			),
			remote: Type.Optional(
				Type.String({
					description:
						"For tree and snapshot: a remote URL, for a repo with no local checkout. Note the git provider refuses to clone rather than spending ten minutes unasked.",
				}),
			),
			purpose: Type.Optional(
				Type.String({
					description:
						"For tree and snapshot: what it is for, e.g. 'fix-410'. Names the tree.",
				}),
			),
			branch: Type.Optional(
				Type.String({ description: "For tree: the branch to check out." }),
			),
			commit: Type.Optional(
				Type.String({ description: "For snapshot: the commit to pin." }),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For snapshot: restrict it to these paths. For record: commit only these, rather than every change, untracked files included; a sweep that would take in build output or more than 500 untracked files is refused until the paths are named.",
				}),
			),
			tree: Type.Optional(
				Type.String({
					description:
						"Which held tree to act on, by key or path; a path inside a quest's tree works too, except for release, which is quest tree-release. Every action but tree, snapshot and trees needs one. Leave it out only when you hold exactly one; holding several, it is refused, since these commit and push.",
				}),
			),
			subject: Type.Optional(
				Type.String({
					description: `For record: the commit subject, in conventional form, type(scope): subject. At most ${SUBJECT_LIMIT} characters, type and scope included; aim for about ${SUBJECT_AIM}, since a length judged by eye is most often refused for one to three characters over.`,
				}),
			),
			body: Type.Optional(
				Type.String({
					description:
						"For record: the commit body. Say why, not what: the diff already says what.",
				}),
			),
			name: Type.Optional(
				Type.String({ description: "For branch: the name to give it." }),
			),
			from: Type.Optional(
				Type.String({
					description:
						"For branch: where the new branch starts. Defaults to where the tree already points. A remote's branch, such as origin/main, is fetched first, so there is no need to fetch beforehand.",
				}),
			),
			onto: Type.Optional(
				Type.String({
					description:
						"For rebase: what to replay onto, as a branch, a tag or a commit. A remote's branch, such as origin/main, is fetched first.",
				}),
			),
			replace: Type.Optional(
				Type.Boolean({
					description:
						"For push: replace what the remote has, needed after a rebase. Always a lease, so it is refused rather than overwriting work that arrived since this tree last fetched.",
				}),
			),
			trunk: Type.Optional(
				Type.String({
					description:
						"For restack, sync and tidy: what the bottom of the stack sits on. Required for a restack, which replays every tracked branch, so a guessed base rewrites all of them onto the wrong thing.",
				}),
			),
			order: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For reorder: the branches in the order you want them, lowest first. Name every branch above the lowest one you are moving, or the reorder would leave one sitting on a branch that moved out from under it.",
				}),
			),
		}),
		// The first argument is the tool call's id, not the arguments. Taking
		// only one parameter here reads the id as the payload, which is a
		// string, so every field comes back undefined and every call silently
		// falls to its default. That shipped: `work` answered the tree listing
		// whatever action it was given.
		execute: async (
			toolCallId,
			rawArgs,
			signal,
			_onUpdate,
			ctx,
		): Promise<Answer> => {
			const args = rawArgs as WorkArgs;
			const action = args.action ?? "trees";
			// Git here answers to this call's signal alone. A turn begun from
			// inside another call, as a review tool's, runs in that call's
			// context, and its signal, fired while it still ran, refused every
			// git as aborted before it started until the session restarted.
			if (!WAITS_ON_GIT.has(action)) {
				return await withCallSignal(signal, () =>
					answerWork(pi, args, signal, ctx),
				);
			}
			// Git and the network can take minutes here, and while a call runs
			// it holds the turn, deaf to the person and the mesh, so one still
			// going after a minute moves to a job, as a long command does.
			return await runOrHandOff<unknown>({
				kind: "work",
				label: `${action} in ${args.tree ?? "the held tree"}`,
				noun: "background work",
				filePrefix: "pi-work",
				stopping: (jobId) =>
					`To stop it, call the jobs tool's stop with ${jobId} (load it with tool_search), which stops git where it is; a replay stopped part-way is resumed or abandoned with work. The person can stop it with /jobs.`,
				toolCallId,
				session: sessionKeyOf(ctx),
				nested: endsWithItsPrompts(ctx.mode),
				signal,
				onUpdate: undefined,
				bus: pi.events,
				// Under the run's own signal, whether or not it is handed off:
				// git a handed-off run starts after the call returned would
				// otherwise read past the ended call to the inherited one.
				run: (owned) =>
					withCallSignal(owned, () => answerWork(pi, args, owned, ctx)),
			});
		},
		renderCall(args, theme, context) {
			return renderInvocation(args, theme, context?.lastComponent);
		},
		renderResult(result, _state, theme, context) {
			return renderAnswer(result, theme, context?.lastComponent);
		},
	});
}

/**
 * The actions that wait on git and the network, which a call hands off
 * once it has run a minute. A record is left out, since its gate can wait
 * on the person, and a panel left open behind a job answers nobody.
 */
const WAITS_ON_GIT: ReadonlySet<string> = new Set([
	"push",
	"rebase",
	"resume",
	"restack",
	"sync",
]);
