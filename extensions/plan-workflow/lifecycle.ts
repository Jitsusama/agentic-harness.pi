/**
 * Manages the full lifecycle of plan mode: turning it on and
 * off, toggling between states, and persisting settings across
 * sessions so nothing gets lost.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getLastEntry, loadPlanDir } from "../../lib/internal/state.js";
import { PLAN_TOOLS, type PlanState } from "./state.js";
import type { PlanWorktree } from "./worktree.js";
import {
	createPlanWorktree,
	generatePlanId,
	resolveRepoRoot,
} from "./worktree.js";

/** Shape of plan-workflow data written to session history. */
interface PersistedState {
	enabled: boolean;
	planDir?: string;
	worktrees?: PlanWorktree[];
	lastPlanFile?: string | null;
}

/** Update the status line to reflect plan mode state. */
export function updateStatus(state: PlanState, ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(
		"plan-workflow",
		state.enabled
			? `${theme.fg("warning", "◈")} ${theme.fg("muted", "Plan")}`
			: undefined,
	);
}

/**
 * Enter plan mode: restrict tools, optionally create
 * worktrees for isolation, and persist state.
 *
 * When repo paths are provided, a worktree is created in
 * each repository at its current HEAD. Use "." for the
 * current repository.
 */
/** Result of activating plan mode, including any worktree failures. */
export interface ActivationResult {
	/** Repo paths that couldn't be resolved or had worktree creation fail. */
	failedRepos: string[];
}

export async function activate(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repos?: string[],
): Promise<ActivationResult> {
	state.planDir = loadPlanDir(ctx.cwd);
	state.savedTools = pi.getActiveTools();
	state.enabled = true;

	const failedRepos: string[] = [];

	if (repos && repos.length > 0) {
		const planId = generatePlanId();

		for (const repo of repos) {
			const repoRoot = await resolveRepoRoot(pi, repo);
			if (!repoRoot) {
				failedRepos.push(repo);
				continue;
			}

			// Skip if we already have a worktree for this repo.
			if (state.worktrees.some((w) => w.repoPath === repoRoot)) continue;

			const worktree = await createPlanWorktree(pi, repoRoot, planId);
			if (worktree) {
				state.worktrees.push(worktree);
			} else {
				failedRepos.push(repo);
			}
		}
	}

	pi.setActiveTools(PLAN_TOOLS);
	updateStatus(state, ctx);
	persist(state, pi);

	return { failedRepos };
}

/** Exit plan mode: restore tools and persist state. */
export function deactivate(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	state.enabled = false;
	pi.setActiveTools(state.savedTools ?? pi.getActiveTools());
	state.savedTools = null;
	updateStatus(state, ctx);
	persist(state, pi);
}

/** Toggle plan mode on or off with user notification. */
export async function toggle(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	if (state.enabled) {
		deactivate(state, pi, ctx);
		ctx.ui.notify("Plan mode off.");
	} else {
		await activate(state, pi, ctx);
		ctx.ui.notify(`Plan mode on. Writes → ${state.planDir}`);
	}
}

/** Restore plan mode state from the session history. */
export function restore(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const saved = getLastEntry<PersistedState>(ctx, "plan-workflow");
	if (saved) {
		state.enabled = saved.enabled ?? false;
		state.planDir = saved.planDir ?? loadPlanDir(ctx.cwd);
		state.worktrees = saved.worktrees ?? [];
		state.lastPlanFile = saved.lastPlanFile ?? null;
	} else {
		state.planDir = loadPlanDir(ctx.cwd);
	}

	if (pi.getFlag("plan") === true) {
		state.enabled = true;
	}

	if (state.enabled) {
		pi.setActiveTools(PLAN_TOOLS);
	}

	updateStatus(state, ctx);
}

/** Save state to session history. */
function persist(state: PlanState, pi: ExtensionAPI): void {
	pi.appendEntry("plan-workflow", {
		enabled: state.enabled,
		planDir: state.planDir,
		worktrees: state.worktrees,
		lastPlanFile: state.lastPlanFile,
	});
}
