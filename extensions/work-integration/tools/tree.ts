/**
 * The `work` tool: trees to work in, and what is in them.
 *
 * `lib/work` has answered the trees question for a while with
 * nothing on top of it, which meant the whole layer was reachable
 * only from tests. This is the surface: cut a tree, pin a
 * snapshot, list what is held, give one back, and read the state
 * of the work inside one.
 *
 * Committing and branching are deliberately absent. The library
 * has no primitives for them yet, and a tool action that exists
 * before the thing it calls is a promise the surface cannot keep.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { citeListing, openSessionStore } from "../../../lib/result/index.js";
import {
	blocksRepoint,
	createGitHistory,
	type HeldTree,
	treeRequestFrom,
} from "../../../lib/work/index.js";
import { treeBroker } from "../broker.js";
import { GLYPH, treeLine } from "../render.js";
import {
	type Answer,
	messageOf,
	refuse,
	renderAnswer,
	renderInvocation,
	say,
} from "./shared.js";

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
					],
					{
						description:
							"tree: cut a worktree at a branch. snapshot: pin a snapshot at a commit. trees: list what this session holds. release: give a tree back. status: what has changed inside a tree. Defaults to trees.",
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
						"Which held tree to act on, by its key or its path. For release and status.",
				}),
			),
		}),
		execute: async (rawArgs): Promise<Answer> => {
			const args = rawArgs as {
				action?: "tree" | "snapshot" | "trees" | "release" | "status";
				repo?: string;
				checkout?: string;
				remote?: string;
				purpose?: string;
				branch?: string;
				commit?: string;
				paths?: string[];
				tree?: string;
			};
			const action = args.action ?? "trees";
			const broker = treeBroker();

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
							view: held.map(treeLine).join("\n"),
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
						`${glyph} ${held.identity.key}\n   ${held.path} · ${held.providerId}`,
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

				const history = createGitHistory({
					exec: async (command, cmdArgs) => {
						const result = await pi.exec(command, cmdArgs);
						return {
							code: result.code,
							stdout: result.stdout,
							stderr: result.stderr,
						};
					},
				});

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
				await broker.release(found);
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
