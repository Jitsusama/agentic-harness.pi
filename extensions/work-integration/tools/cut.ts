/**
 * Cutting a worktree at a branch, or pinning a snapshot at a commit, and
 * saying where it landed: its key, its path, what cut it and its head,
 * with a warm `target/` and the repo's rules when they apply.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Exec } from "../../../lib/core/exec/index.ts";
import { sessionCwd } from "../../../lib/core/session/index.ts";
import { treeRequestFrom } from "../../../lib/core/work/ask.ts";
import type { TreeBroker } from "../../../lib/core/work/broker.ts";
import { repoRulesNote } from "../../../lib/internal/session/repo-rules.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { GLYPH } from "../render.ts";
import { candidatesFor, machineSeams, warmStart } from "../warm-start.ts";
import { type Answer, refuse, say } from "./shared.ts";

/** What a cut is asked: the repo, where to cut it from, and at what. */
export interface CutAsk {
	repo?: string;
	checkout?: string;
	remote?: string;
	purpose?: string;
	branch?: string;
	commit?: string;
	paths?: string[];
}

/** Cut a worktree or pin a snapshot, and name what was cut. */
export async function cutTree(
	exec: Exec,
	broker: TreeBroker,
	action: "tree" | "snapshot",
	args: CutAsk,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<Answer> {
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
	const held = await broker.ensure(outcome.request, signal ? { signal } : {});
	const glyph = action === "snapshot" ? GLYPH.snapshot : GLYPH.tree;
	// A worktree is where a build happens, so a Rust one starts from a
	// sibling's target/ rather than compiling every dependency again.
	// A snapshot is read, not built, and is left as cut.
	const warmedFrom =
		action === "tree"
			? await warmStart(
					held.path,
					candidatesFor(held.path, args.checkout),
					machineSeams(exec),
				)
			: undefined;
	const warmed = warmedFrom
		? `\n   target/ cloned from ${displayPath(warmedFrom)}`
		: "";
	// pi read AGENTS.md only where this session started, so a tree
	// in another repo comes with that repo's rules, once a repo.
	const rules = repoRulesNote({
		tree: held.path,
		cwd: sessionCwd(ctx),
		session: ctx.sessionManager?.getSessionId?.() ?? "",
	});
	// Named, as a branch's start is, so a tree cut from a stale base
	// shows at once; a head that will not read is left out.
	const head = await exec("git", [
		"-C",
		held.path,
		"rev-parse",
		"--short=12",
		"HEAD",
	]);
	const at =
		head.code === 0 && head.stdout.trim() !== ""
			? ` · at ${head.stdout.trim()}`
			: "";
	return say(
		`${glyph} ${held.identity.key}\n   ${displayPath(held.path)} · ${held.providerId}${at}${warmed}${rules ? `\n\n${rules}` : ""}`,
		// The details keep the absolute path on purpose. A tilde is a
		// courtesy for a reader, not something a caller can open, and
		// this is the value another call gets fed.
		{ ok: true, path: held.path, key: held.identity.key },
	);
}
