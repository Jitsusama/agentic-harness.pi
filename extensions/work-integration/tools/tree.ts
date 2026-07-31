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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { sessionGateDeps } from "../../../lib/internal/gate/session-deps.js";
import { runProseGate } from "../../../lib/internal/guardian/prose-gate.js";
import { citeListing, openSessionStore } from "../../../lib/result/index.js";
import type { Exec } from "../../../lib/review/index.js";
import { displayPath } from "../../../lib/ui/index.js";
import {
	blocksRepoint,
	cautionsFrom,
	createGitAuthor,
	createGitHistory,
	createGitPublisher,
	createGitRebaser,
	createGitStacks,
	type HeldTree,
	refusalFrom,
	treeRequestFrom,
} from "../../../lib/work/index.js";
import { execFor, objectionsTo, treeBroker } from "../broker.js";
import { GLYPH, treeLine } from "../render.js";
import {
	type Answer,
	messageOf,
	refuse,
	renderAnswer,
	renderInvocation,
	say,
} from "./shared.js";
import { runStackAction } from "./stack.js";

/** Find a held tree by the key or path a caller named. */
function heldByName(held: readonly HeldTree[], name: string) {
	return held.find((h) => h.identity.key === name || h.path === name);
}

/** Register the `work` tool. */
export function registerWorkTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "work",
		label: "Work",
		description:
			"Get somewhere to work and know what is in it: cut a worktree at a branch, pin a snapshot at a commit, list the trees this session holds, give one back, or read what has changed inside one. Call with no action to list what is held.",
		promptSnippet: "Somewhere to work: tree, snapshot, trees, release, status.",
		promptGuidelines: [
			"A worktree is checked out at a branch and is yours alone; a snapshot is pinned to a commit and may be shared with another reader. Ask for the one that matches what you are about to do.",
			"Always say what the tree is for. The purpose names it, which is how it is recognised later and how a second caller avoids cutting a duplicate.",
			"Read status before repointing or discarding a tree. An untracked file is work, and overwriting one cannot be undone.",
			"Never call git worktree yourself. A tree cut outside the broker is one nothing will clean up.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("tree"),
						Type.Literal("snapshot"),
						Type.Literal("trees"),
						Type.Literal("release"),
						Type.Literal("status"),
						Type.Literal("record"),
						Type.Literal("branch"),
						Type.Literal("push"),
						Type.Literal("rebase"),
						Type.Literal("resume"),
						Type.Literal("abandon"),
						Type.Literal("stack"),
						Type.Literal("track"),
						Type.Literal("untrack"),
						Type.Literal("reparent"),
						Type.Literal("reorder"),
						Type.Literal("restack"),
						Type.Literal("sync"),
					],
					{
						description:
							"tree: cut a worktree at a branch. snapshot: pin a snapshot at a commit. trees: list what this session holds. release: give a tree back. status: what has changed inside a tree. record: stage and commit the work in a tree. branch: make a branch in a tree and check it out. push: publish the branch, setting upstream the first time. rebase: replay the branch onto another ref, reporting a conflict as a halt rather than a failure. resume: carry a halted replay on once the conflicts are settled. abandon: put the tree back the way it was before a halted replay. stack: show what sits on what. track: record that a branch sits on another, or on trunk. untrack: forget a branch, moving whatever sat on it down. reparent: point a branch at a different parent. reorder: rearrange a chain into the order you name, lowest first. restack: replay every tracked branch onto trunk, in order, stopping at the first halt. sync: fetch trunk and then restack onto where it now is, which is the daily operation and one verb because doing half of it replays the stack onto a trunk as stale as before. Defaults to trees.",
					},
				),
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
						"Path to a local checkout to cut from. Much cheaper than a remote, and required unless a remote is given.",
				}),
			),
			remote: Type.Optional(
				Type.String({
					description:
						"Remote URL, for a repo with no local checkout. Note the git provider refuses to clone rather than spending ten minutes unasked.",
				}),
			),
			purpose: Type.Optional(
				Type.String({
					description: "What the tree is for, e.g. 'fix-410'. Names the tree.",
				}),
			),
			branch: Type.Optional(
				Type.String({ description: "Branch to check out, for a worktree." }),
			),
			commit: Type.Optional(
				Type.String({ description: "Commit to pin, for a snapshot." }),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Restrict a snapshot to these paths.",
				}),
			),
			tree: Type.Optional(
				Type.String({
					description:
						"Which held tree to act on, by its key or its path. For release, status, record and branch.",
				}),
			),
			subject: Type.Optional(
				Type.String({
					description:
						"Commit subject, for record. Conventional form: type(scope): subject.",
				}),
			),
			body: Type.Optional(
				Type.String({
					description:
						"Commit body, for record. Say why, not what: the diff already says what.",
				}),
			),
			name: Type.Optional(
				Type.String({ description: "Branch name, for branch." }),
			),
			from: Type.Optional(
				Type.String({
					description:
						"Where a new branch starts, for branch. Defaults to where the tree already points.",
				}),
			),
			onto: Type.Optional(
				Type.String({
					description:
						"What to replay onto, for rebase. A branch, a tag or a commit.",
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
						"What the bottom of the stack sits on, for restack. Required there: a restack replays every tracked branch, so a guessed base rewrites all of them onto the wrong thing.",
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
			_toolCallId,
			rawArgs,
			signal,
			_onUpdate,
			ctx,
		): Promise<Answer> => {
			const args = rawArgs as {
				action?:
					| "tree"
					| "snapshot"
					| "trees"
					| "release"
					| "status"
					| "record"
					| "branch"
					| "push"
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
			};
			const action = args.action ?? "trees";
			const broker = treeBroker();
			// Built once per call and carrying the caller's signal, so pressing
			// escape reaches the git child rather than only the promise waiting on
			// it. Without it a blocked command outlives the request that started
			// it, which is how a hung rebase became unstoppable.
			const exec = execFor(pi, signal);

			try {
				if (action === "trees") {
					const held = broker.held();
					if (held.length === 0) {
						return say(
							`${GLYPH.named} No trees held. Ask for one with action 'tree' or 'snapshot'.`,
							{ ok: true, held: 0 },
						);
					}
					return say(
						citeListing(openSessionStore(), {
							view: held
								.map((one) => treeLine(one, broker.cutHere(one.path)))
								.join("\n"),
							records: [...held],
							unit: "trees",
							narrowing: "Query the stored result for the trees you need.",
						}),
						{ ok: true, held: held.length },
					);
				}

				if (action === "tree" || action === "snapshot") {
					if (!args.repo) {
						return refuse(
							`${GLYPH.refused} Name the repo to cut from, as a repo key like github:Shopify/world.`,
						);
					}
					const outcome = treeRequestFrom({
						intent: action === "tree" ? "worktree" : "snapshot",
						repo: {
							key: args.repo,
							...(args.checkout ? { localPath: args.checkout } : {}),
							...(args.remote ? { remoteUrl: args.remote } : {}),
						},
						purpose: args.purpose ?? "",
						...(args.branch ? { branch: args.branch } : {}),
						...(args.commit ? { commit: args.commit } : {}),
						...(args.paths ? { paths: args.paths } : {}),
					});
					if ("refusal" in outcome) {
						return refuse(`${GLYPH.refused} ${outcome.refusal}`);
					}
					const held = await broker.ensure(outcome.request);
					const glyph = action === "snapshot" ? GLYPH.snapshot : GLYPH.tree;
					return say(
						`${glyph} ${held.identity.key}\n   ${displayPath(held.path)} · ${held.providerId}`,
						// The details keep the absolute path on purpose. A tilde is a
						// courtesy for a reader, not something a caller can open, and
						// this is the value another call gets fed.
						{ ok: true, path: held.path, key: held.identity.key },
					);
				}

				const held = broker.held();
				if (!args.tree) {
					return refuse(
						`${GLYPH.refused} Say which tree, by its key or its path. ${held.length} held.`,
					);
				}
				const found = heldByName(held, args.tree);
				if (!found) {
					// Naming what is held turns a typo into a correction
					// rather than a second guess.
					const names =
						held.length === 0
							? "none are held"
							: held.map((h) => h.identity.key).join(", ");
					return refuse(
						`${GLYPH.refused} No held tree called ${args.tree}: ${names}.`,
					);
				}

				const history = createGitHistory({ exec });

				if (action === "record") {
					if (!args.subject) {
						return refuse(
							`${GLYPH.refused} Say what the commit is for, as a subject. Conventional form: type(scope): subject.`,
						);
					}
					// The same prose gate a commit typed into a shell meets. That one is
					// reached by intercepting the command, and this path never runs a
					// command: it commits through the exec seam directly, so it arrived
					// behind the guardian rather than in front of it. A convention
					// enforced on one road into the same repository and not the other is
					// not enforced, it is just inconvenient in one place.
					//
					// Only the gate is shared, not the review panel. Approving a message
					// is what a human does to a command they did not write; here the
					// subject and body are arguments in a tool call they can already see.
					const proposed = [args.subject, args.body]
						.filter((part) => part !== undefined && part !== "")
						.join("\n\n");
					// A guardian result may also ask for a rewrite, which is a shell
					// concept: there is no command here to substitute. Narrowed by asking
					// what the value has rather than asserting what it is, so a third arm
					// added later is a type error here instead of a silent skip.
					const objection = runProseGate(sessionGateDeps(ctx, pi), proposed);
					if (objection !== undefined && "block" in objection) {
						return refuse(`${GLYPH.refused} ${objection.reason}`);
					}

					const author = createGitAuthor({ exec });
					const before = await history.status(found.path);
					if (before.changed.length === 0) {
						// Committing nothing succeeds at the git level and
						// leaves the caller believing work was recorded.
						return refuse(
							`${GLYPH.clean} Nothing to record in ${found.identity.key}: the tree is clean.`,
						);
					}
					await author.stage(
						found.path,
						args.paths && args.paths.length > 0 ? args.paths : undefined,
					);
					await author.commit(found.path, {
						subject: args.subject,
						...(args.body ? { body: args.body } : {}),
					});
					const head = await history.head(found.path);
					return say(
						`${GLYPH.clean} Recorded ${before.changed.length} paths in ${found.identity.key} at ${head.commit.slice(0, 12)}.`,
						{
							ok: true,
							commit: head.commit,
							recorded: before.changed.length,
						},
					);
				}

				if (action === "branch") {
					if (!args.name) {
						return refuse(`${GLYPH.refused} Name the branch to make.`);
					}
					const author = createGitAuthor({ exec });
					await author.branch(
						found.path,
						args.name,
						args.from ? { from: args.from } : undefined,
					);
					return say(
						`${GLYPH.tree} ${found.identity.key} is on ${args.name}.`,
						{ ok: true, branch: args.name },
					);
				}

				if (action === "push") {
					// Ask before publishing, because the reason not to is often a
					// fact this layer cannot see. On a backend with a merge queue,
					// pushing to an enqueued branch ejects it and everything batched
					// with it, and that is knowledge the hosting layer holds.
					const head = await history.head(found.path);
					let cautions: readonly string[] = [];
					if (head.branch !== undefined) {
						const objected = await objectionsTo(pi, {
							repoKey: found.identity.key,
							branch: head.branch,
							treePath: found.path,
							replacing: args.replace === true,
						});
						const blocked = refusalFrom(objected);
						if (blocked !== undefined) {
							return refuse(`${GLYPH.refused} ${blocked}`);
						}
						// Kept for after the push. A caution decorates what
						// happened rather than becoming what happened.
						cautions = cautionsFrom(objected);
					}
					const publisher = createGitPublisher({ exec });
					const outcome = await publisher.push(
						found.path,
						args.replace ? { replace: true } : undefined,
					);
					if (outcome.kind === "refused") {
						return refuse(`${GLYPH.refused} ${outcome.reason}`);
					}
					if (outcome.kind === "already-there") {
						// Said rather than dressed as a push, because "published"
						// about a no-op is how somebody concludes their commit went
						// up when it did not.
						return say(
							`${GLYPH.clean} ${outcome.remote}/${outcome.branch} already has this. Nothing to publish.`,
							{ ok: true, branch: outcome.branch, published: false },
						);
					}
					const notes = [
						outcome.tracked ? "tracking it from now on" : undefined,
						outcome.replaced ? "replacing what was there" : undefined,
					].filter((note) => note !== undefined);
					return say(
						[
							`${GLYPH.tree} ${outcome.branch} published to ${outcome.remote}${notes.length > 0 ? `, ${notes.join(", ")}` : ""}.`,
							...cautions.map((caution) => `   ${GLYPH.dirty} ${caution}`),
						].join("\n"),
						{
							ok: true,
							branch: outcome.branch,
							published: true,
							...(cautions.length > 0 ? { cautions } : {}),
						},
					);
				}

				if (
					action === "rebase" ||
					action === "resume" ||
					action === "abandon"
				) {
					return await replay(exec, found, action, args.onto);
				}

				if (
					action === "stack" ||
					action === "track" ||
					action === "untrack" ||
					action === "reparent" ||
					action === "reorder" ||
					action === "restack" ||
					action === "sync"
				) {
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

				if (action === "status") {
					const state = await history.status(found.path);
					const head = await history.head(found.path);
					const at = head.branch
						? `on ${head.branch}`
						: `detached at ${head.commit.slice(0, 12)}`;
					if (state.changed.length === 0) {
						return say(
							`${GLYPH.clean} ${found.identity.key} is clean, ${at}.`,
							{ ok: true, clean: true },
						);
					}
					const lines = state.changed.map((c) => `   ${c.kind} ${c.path}`);
					return say(
						citeListing(openSessionStore(), {
							view: `${GLYPH.dirty} ${found.identity.key} has ${state.changed.length} changed paths, ${at}.\n${lines.join("\n")}`,
							records: [...state.changed],
							unit: "paths",
							narrowing: "Query the stored result for the paths you need.",
						}),
						{ ok: true, clean: false, changed: state.changed.length },
					);
				}

				// Release. The work inside is the caller's, and losing it
				// is not recoverable, so the same sentence that guards a
				// repoint guards this.
				const state = await history.status(found.path);
				const blocked = blocksRepoint(state);
				if (blocked) {
					return refuse(`${GLYPH.refused} ${blocked}`);
				}
				const gone = await broker.release(found);
				if (gone.kind === "no-provider") {
					// Said as a refusal because nothing happened. This used to
					// report success, leaving a tree on disk, tracked by git, with
					// its record dropped and nothing able to name it again.
					const who =
						gone.registered.length === 0
							? "none are registered"
							: gone.registered.join(", ");
					return refuse(
						`${GLYPH.refused} ${found.identity.key} was cut by ${gone.wanted}, which is not registered here, so nothing can remove it. Registered: ${who}. The tree is still at ${displayPath(gone.path)} and still listed, so this can be retried once that provider loads.`,
					);
				}
				return say(`${GLYPH.named} Released ${found.identity.key}.`, {
					ok: true,
					released: found.identity.key,
				});
			} catch (error) {
				return refuse(`${GLYPH.refused} ${messageOf(error)}`);
			}
		},
		renderCall(args, theme) {
			return renderInvocation(args, theme);
		},
		renderResult(result, _state, theme) {
			return renderAnswer(result, theme);
		},
	});
}

/**
 * Replay a branch, or end a replay that stopped.
 *
 * The three verbs live together because they are one state machine, and the
 * halt is the state worth writing carefully: a caller who is told only that
 * something failed has to work out from the repository itself whether a rebase
 * is part-way through, which is exactly the knowledge the tool already had.
 */
async function replay(
	exec: Exec,
	found: HeldTree,
	action: "rebase" | "resume" | "abandon",
	onto: string | undefined,
): Promise<Answer> {
	const rebaser = createGitRebaser({ exec });

	if (action === "resume" || action === "abandon") {
		const outcome =
			action === "resume"
				? await rebaser.resume(found.path)
				: await rebaser.abandon(found.path);
		if (outcome.kind === "refused") {
			return refuse(`${GLYPH.refused} ${outcome.reason}`);
		}
		if (outcome.kind === "halted") {
			// Said the same way the first halt is said. A stack halts more than once,
			// and the second one used to print no branch at all, which is the moment
			// a reader most needs to know which branch they are being asked about.
			return refuse(haltLines(outcome.conflicted, subjectOfHalt(outcome)));
		}
		if (outcome.kind === "abandoned") {
			return say(
				`${GLYPH.tree} Replay abandoned. ${outcome.branch} is back where it was.`,
				{ ok: true, branch: outcome.branch },
			);
		}
		// The replay landed, so the stack's record of where this branch sits is now
		// out of date, and only a restack that ran to completion used to update it. A
		// halt settled by hand is the documented way out of the commonest failure
		// here, and it left the boundary describing the branch as it was before the
		// replay: the next restack then measured from there and handed the branch
		// copies of its parent's history.
		await createGitStacks({ exec, rebaser }).settled(found.path);
		return say(`${GLYPH.tree} ${outcome.branch} replayed.`, {
			ok: true,
			branch: outcome.branch,
		});
	}

	if (onto === undefined) {
		return refuse(
			`${GLYPH.refused} Name what to replay onto, with onto. A rebase has no sensible default: replaying onto the wrong base rewrites every commit on the branch.`,
		);
	}

	const outcome = await rebaser.rebase(found.path, onto);
	if (outcome.kind === "refused") {
		return refuse(`${GLYPH.refused} ${outcome.reason}`);
	}
	if (outcome.kind === "already-there") {
		return say(
			`${GLYPH.clean} ${outcome.branch} is already on top of ${outcome.onto}. Nothing to replay.`,
			{ ok: true, branch: outcome.branch, replayed: 0 },
		);
	}
	if (outcome.kind === "halted") {
		return refuse(
			haltLines(
				outcome.conflicted,
				`${outcome.branch} onto ${outcome.onto}${outcome.at === undefined ? "" : `, at ${outcome.at}`}`,
			),
		);
	}
	return say(
		`${GLYPH.tree} ${outcome.branch} replayed onto ${outcome.onto}, ${outcome.commits} ${outcome.commits === 1 ? "commit" : "commits"}.`,
		{ ok: true, branch: outcome.branch, replayed: outcome.commits },
	);
}

/**
 * A halt, said so the next move is obvious.
 *
 * The paths are the work, and the two verbs are the only ways out, so both are
 * named. A halt is reported through the refusal path because the tree is not
 * where it was asked to be, but it is a state to act on rather than an error.
 */
/**
 * How a halt names itself, when git's replay state said enough to.
 *
 * Built to read the same whether it came from starting a replay or carrying one
 * on, because to the person reading it they are the same event.
 */
function subjectOfHalt(halt: {
	branch?: string;
	onto?: string;
	at?: string;
}): string | undefined {
	if (halt.branch === undefined) return undefined;
	const onto = halt.onto ? ` onto ${halt.onto}` : "";
	const at = halt.at ? `, at ${halt.at}` : "";
	return `${halt.branch}${onto}${at}`;
}

function haltLines(conflicted: readonly string[], what?: string): string {
	const head =
		what === undefined ? "Replay halted." : `Replay halted: ${what}.`;
	const paths =
		conflicted.length === 0
			? ["   nothing is unmerged, so something else stopped it"]
			: conflicted.map((path) => `   ${GLYPH.dirty} ${path}`);
	return [
		`${GLYPH.refused} ${head}`,
		...paths,
		"",
		"Settle these, then resume. Or abandon, and the tree goes back to where it started.",
	].join("\n");
}
