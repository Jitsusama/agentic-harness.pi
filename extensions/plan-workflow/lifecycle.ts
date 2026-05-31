/**
 * The orchestration layer. It composes the pure cores (machine,
 * plan-doc, routing, render, discipline) with the two impure
 * worlds they avoid: the filesystem (the plan document) and pi
 * (session history, the scoreboard).
 *
 * The document is the single source of truth. The session
 * history holds only a pointer to it, so on restore the document
 * on disk wins over anything cached: we read it and rehydrate
 * from it. That is what lets a plan survive a reload, a resume,
 * and a cold start in a brand-new session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getLastEntry } from "../../lib/internal/state.js";
import { disciplineFor } from "./discipline.js";
import { findPlans, type PlanSummary } from "./discovery.js";
import { type Stage, transition } from "./machine.js";
import {
	extractTitle,
	formatPlanId,
	parsePlan,
	progress,
	revise,
	scaffold,
	serializePlan,
} from "./plan-doc.js";
import { renderStatus, renderWidget } from "./render.js";
import { defaultPlanDir, planFileName, resolvePlanDir } from "./routing.js";
import type { PlanState } from "./state.js";

/** Width fallback when the terminal width is unknown. */
const DEFAULT_WIDTH = 80;

/** What the agent passes through the plan tool for a transition. */
export interface TransitionParams {
	action: "think" | "draft" | "build" | "conclude" | "retire";
	note?: string;
	reason?: string;
	/** draft: the plan's human title (becomes the document H1). */
	title?: string;
}

/** Outcome of a transition: the new discipline, or a refusal. */
export type ApplyResult =
	| { ok: true; message: string; planPath: string | null }
	| { ok: false; guidance: string };

/** Read the front-matter and body of a plan into runtime fields. */
export function hydrateFromDoc(docText: string): {
	stage: Stage;
	planId: string;
	title: string | null;
	done: number;
	total: number;
} | null {
	const doc = parsePlan(docText);
	if (!doc) return null;
	const { total, done } = progress(doc.body);
	return {
		stage: doc.frontMatter.stage,
		planId: doc.frontMatter.id,
		title: extractTitle(doc.body),
		done,
		total,
	};
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function isoDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 5);
}

async function gitCommonDir(pi: ExtensionAPI): Promise<string | null> {
	const result = await pi.exec("git", [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	return result.code === 0 ? result.stdout.trim() : null;
}

async function fallbackPlanDir(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<string> {
	const common = await gitCommonDir(pi);
	return common ? defaultPlanDir(common) : path.join(ctx.cwd, ".pi", "plans");
}

/** Refresh runtime fields from the document on disk. The doc wins. */
function refreshFromDoc(state: PlanState): void {
	if (!state.planPath) return;
	try {
		const hydrated = hydrateFromDoc(fs.readFileSync(state.planPath, "utf-8"));
		if (hydrated) {
			state.stage = hydrated.stage;
			state.planId = hydrated.planId;
			state.title = hydrated.title;
			state.done = hydrated.done;
			state.total = hydrated.total;
		}
	} catch {
		// Document unreadable (moved or deleted): leave the cache as-is;
		// callers handle a vanished plan by resting at idle.
	}
}

async function createDoc(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	title: string,
	stage: Stage,
	session: string | null,
	now: Date,
): Promise<void> {
	const id = formatPlanId(now, randomSuffix());
	const fallback = await fallbackPlanDir(pi, ctx);
	const common = await gitCommonDir(pi);
	const repoRoot = common ? path.dirname(common) : null;
	const dir = await resolvePlanDir(
		{ id, title, cwd: ctx.cwd, repoRoot },
		fallback,
	);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, planFileName(id, title));
	fs.writeFileSync(
		file,
		scaffold({
			id,
			title,
			stage,
			updated: isoDate(now),
			sessions: session ? [session] : [],
		}),
	);
	state.planPath = file;
	state.planId = id;
	state.title = title;
}

function reviseDocOnDisk(
	planPath: string,
	change: { stage?: Stage; date?: Date; session?: string },
): void {
	try {
		const doc = parsePlan(fs.readFileSync(planPath, "utf-8"));
		if (!doc) return;
		fs.writeFileSync(planPath, serializePlan(revise(doc, change)));
	} catch {
		// Document unreadable: nothing to revise. The next restore
		// will fall back to idle if the file is truly gone.
	}
}

/** Whether a stage is terminal: the plan has ended. */
function isTerminal(stage: Stage): boolean {
	return stage === "concluded" || stage === "retired";
}

/** Forget the active plan, returning the cache to a fresh slate. */
function clearPlan(state: PlanState): void {
	state.planPath = null;
	state.planId = null;
	state.title = null;
	state.done = 0;
	state.total = 0;
}

function sessionId(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getSessionId?.() ?? null;
	} catch {
		// Session id unavailable (in-memory session): skip association.
		return null;
	}
}

/**
 * Apply a stage transition: validate it through the machine,
 * write the change to the document (creating it on draft), then
 * refresh from the document, repaint the scoreboard and persist
 * the pointer. Returns the new stage's discipline, or a refusal.
 */
export async function applyTransition(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: TransitionParams,
): Promise<ApplyResult> {
	const result = transition(
		{ stage: state.stage },
		{ action: params.action, note: params.note, reason: params.reason },
	);
	if (!result.ok) return { ok: false, guidance: result.guidance };

	const priorStage = state.stage;
	const newStage = result.state.stage;
	const now = new Date();
	const session = sessionId(ctx);

	if (params.action === "draft") {
		await createDoc(
			state,
			pi,
			ctx,
			params.title?.trim() || "Untitled Plan",
			newStage,
			session,
			now,
		);
	} else if (params.action === "think" && isTerminal(priorStage)) {
		// Thinking after a terminal stage opens a fresh plan: forget the
		// old document so the next draft writes a new one, and leave the
		// concluded or retired document untouched on disk.
		clearPlan(state);
	} else if (state.planPath) {
		reviseDocOnDisk(state.planPath, {
			stage: newStage,
			date: now,
			session: session ?? undefined,
		});
	}

	state.stage = newStage;
	refreshFromDoc(state);
	updateScoreboard(state, ctx);
	persist(state, pi);
	return {
		ok: true,
		message: disciplineFor(state.stage),
		planPath: state.planPath,
	};
}

/**
 * Attach to an existing plan by path or id, then rehydrate from
 * it. This is the cold-start resuscitation: a fresh session
 * re-adopts a plan the document already describes.
 */
export async function attach(
	state: PlanState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	ref: string,
): Promise<boolean> {
	const found = await locatePlan(pi, ctx, ref);
	if (!found) return false;
	state.planPath = found;
	refreshFromDoc(state);
	const session = sessionId(ctx);
	if (session) reviseDocOnDisk(found, { session });
	refreshFromDoc(state);
	updateScoreboard(state, ctx);
	persist(state, pi);
	return true;
}

/**
 * List every plan at or below the resolved plan root, newest
 * first. The root is the directory a plan would be written to
 * now, consulting any registered router, so a personal home is
 * covered as well as the durable default.
 */
export async function listPlans(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<PlanSummary[]> {
	const fallback = await fallbackPlanDir(pi, ctx);
	const common = await gitCommonDir(pi);
	const repoRoot = common ? path.dirname(common) : null;
	const root = await resolvePlanDir(
		{ id: "", title: "", cwd: ctx.cwd, repoRoot },
		fallback,
	);
	return findPlans(root);
}

/** Resolve a plan reference to a file path: a direct path, or an id prefix. */
async function locatePlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	ref: string,
): Promise<string | null> {
	const direct = path.resolve(ctx.cwd, ref);
	if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

	const dir = await fallbackPlanDir(pi, ctx);
	try {
		const match = fs
			.readdirSync(dir)
			.find((name) => name.startsWith(ref) && name.endsWith(".md"));
		return match ? path.join(dir, match) : null;
	} catch {
		// Plan directory missing: nothing to locate.
		return null;
	}
}

/** Persist the pointer to the active plan. The document holds the truth. */
export function persist(state: PlanState, pi: ExtensionAPI): void {
	pi.appendEntry("plan-workflow", {
		planPath: state.planPath,
		stage: state.stage,
	});
}

/** Shape of the persisted pointer. */
interface PersistedPointer {
	planPath?: string | null;
	stage?: Stage;
}

/**
 * Restore the active plan on session start. Reads the pointer
 * from history, then rehydrates from the document on disk, which
 * wins over the cached stage. A vanished document drops the
 * session back to idle.
 */
export function restore(
	state: PlanState,
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const saved = getLastEntry<PersistedPointer>(ctx, "plan-workflow");
	if (!saved?.planPath) {
		updateScoreboard(state, ctx);
		return;
	}
	state.planPath = saved.planPath;
	refreshFromDoc(state);
	if (!state.planId) {
		// Document gone: forget the pointer and rest at idle.
		state.planPath = null;
		state.stage = "idle";
	}
	updateScoreboard(state, ctx);
}

/**
 * Re-read the active plan document and repaint the scoreboard
 * only when the stage, progress or title actually changed. This
 * is what makes a checkbox edit show up live: the document is the
 * source of truth, so the safe move is always to re-read it.
 */
export function syncFromDoc(state: PlanState, ctx: ExtensionContext): void {
	if (!state.planPath) return;
	const before = `${state.stage}|${state.done}|${state.total}|${state.title}`;
	refreshFromDoc(state);
	const after = `${state.stage}|${state.done}|${state.total}|${state.title}`;
	if (after !== before) updateScoreboard(state, ctx);
}

/** Repaint the status line and the widget from the current state. */
export function updateScoreboard(
	state: PlanState,
	ctx: ExtensionContext,
): void {
	ctx.ui.setStatus("plan-workflow", renderStatus(state.stage, ctx.ui.theme));
	const width = process.stdout.columns || DEFAULT_WIDTH;
	ctx.ui.setWidget(
		"plan-workflow",
		state.stage === "idle"
			? undefined
			: renderWidget(
					{
						stage: state.stage,
						title: state.title,
						done: state.done,
						total: state.total,
					},
					ctx.ui.theme,
					width,
				),
	);
}
