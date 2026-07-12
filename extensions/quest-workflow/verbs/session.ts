/**
 * Session verbs: attach, detach, rename. Plus the
 * `spawn-*` verbs that open a new terminal tab, pane or
 * window via the registered terminal driver.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	pickResumeSession,
	resolveSpawnCwd,
} from "../../../lib/internal/quest/reopen.js";
import {
	deriveLiveness,
	formatRelativeAge,
	type SessionView,
} from "../../../lib/internal/quest/session-liveness.js";
import type { QuestSession } from "../../../lib/quest/index.js";
import {
	resolveDriver,
	type TerminalLayout,
} from "../../../lib/terminal/index.js";
import {
	attachSessionToLoaded,
	detachSessionFromLoaded,
	detachSessionInQuestDir,
	reconcileSessionMembership,
	renameSessionOnLoaded,
} from "../lifecycle.js";
import { buildSessionSnapshot } from "../liveness.js";
import {
	auditSessionMembership,
	getQuestEntry,
	planDeadSessions,
	planSessionRepair,
} from "../lookup.js";
import type { QuestState } from "../state.js";
import {
	currentSessionId,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

/**
 * Repair session-to-quest membership across the store, in two
 * independent passes read from two authorities:
 *
 * - Divergence: a session active on more than one quest is resolved
 *   to the one its own log names as owner (see `planSessionRepair`).
 * - Provably dead: an active session whose captured identity a probe
 *   reads gone is a detach candidate (see `planDeadSessions`). Only
 *   identity-backed deadness qualifies, so this is an observation the
 *   user acts on, never the recency heuristic rewriting membership.
 *
 * Previews both by default and mutates nothing; `force:true` applies
 * the divergence detaches and the dead detaches. Conflicted records
 * (a log naming no claimant) are always left for the user to resolve
 * by loading the true quest.
 */
export async function sessionAudit(
	state: QuestState,
	params: QuestToolParams,
): Promise<QuestResult> {
	const plan = planSessionRepair(state);
	const dead = await planDeadSessions(state);
	if (
		plan.resolvable.length === 0 &&
		plan.conflicted.length === 0 &&
		dead.length === 0
	) {
		return ok("No session divergence: every session is active on one quest.", {
			divergences: auditSessionMembership(state),
			plan,
			dead,
		});
	}
	const resolvableLines = plan.resolvable.map(
		(r) =>
			`${r.sessionId} -> keep ${r.keep}, detach from ${r.detachFrom.join(", ")}`,
	);
	const conflictedLines = plan.conflicted.map(
		(d) =>
			`${d.sessionId} conflicted across ${d.questIds.join(", ")} (log names no claimant)`,
	);
	const deadLines = dead.map(
		(d) => `${d.sessionId} dead (probe) on ${d.questId}; would detach`,
	);
	if (!params.force) {
		const parts = [
			`${plan.resolvable.length} resolvable, ${dead.length} dead, ${plan.conflicted.length} conflicted. Pass force:true to apply the resolvable and dead detaches; conflicted records are left for you to resolve by loading the true quest.`,
			...resolvableLines,
			...deadLines,
			...conflictedLines,
		];
		return ok(parts.join("\n"), { plan, dead, applied: false });
	}
	let detached = 0;
	for (const entry of plan.resolvable) {
		const gone = reconcileSessionMembership(state, entry.sessionId, entry.keep);
		detached += gone.length;
	}
	let deadDetached = 0;
	for (const entry of dead) {
		const target = getQuestEntry(state, entry.questId);
		if (!target) continue;
		const result = detachSessionInQuestDir(target.dir, entry.sessionId);
		if (result.ok && result.detached) deadDetached += 1;
	}
	const summary = [
		`Repaired ${plan.resolvable.length} divergent session(s), detached ${detached} stray membership(s); detached ${deadDetached} dead session(s). ${plan.conflicted.length} conflicted record(s) left untouched.`,
		...conflictedLines,
	];
	return ok(summary.join("\n"), {
		plan,
		dead,
		applied: true,
		detached,
		deadDetached,
	});
}

export function sessionAttach(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) {
		return refuse(
			"Could not determine current pi session id. Pass it explicitly in `sessionId`.",
		);
	}
	const session: QuestSession = {
		id,
		started: new Date().toISOString(),
		status: "active",
	};
	if (params.name?.trim()) session.name = params.name.trim();
	if (params.cwd?.trim()) session.cwd = params.cwd.trim();
	else if (ctx.cwd) session.cwd = ctx.cwd;
	const result = attachSessionToLoaded(state, session);
	if (!result.ok) return refuse(result.guidance);
	return ok(
		result.added
			? `Attached session ${id} to ${state.questId}.`
			: `Session ${id} was already attached; refreshed status.`,
		{ session, added: result.added },
	);
}

export function sessionDetach(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) {
		return refuse(
			"Could not determine session id to detach. Pass it explicitly in `sessionId`.",
		);
	}
	const result = detachSessionFromLoaded(state, id);
	if (!result.ok) return refuse(result.guidance);
	if (!result.detached) {
		return refuse(
			`Session ${id} is not attached (or already detached) on this quest.`,
		);
	}
	return ok(`Detached session ${id}.`, { sessionId: id });
}

export function sessionRename(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	if (!state.questId) return refuse("Load a quest first.");
	if (!params.name?.trim())
		return refuse("Pass the new session name in `name`.");
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) return refuse("Pass a session id in `sessionId`.");
	const result = renameSessionOnLoaded(state, id, params.name.trim());
	if (!result.ok) return refuse(result.guidance);
	if (!result.renamed) {
		return refuse(
			`Session ${id} is not attached to this quest or already has that name.`,
		);
	}
	return ok(`Renamed session ${id} to "${params.name.trim()}".`, {
		sessionId: id,
		name: params.name.trim(),
	});
}

/**
 * Decide the command the spawned terminal runs. An explicit command
 * wins outright. Otherwise, when exactly one resumable session was
 * picked, resume it with `pi --session <id>`; with no resumable
 * session (none or several), start a fresh `pi`.
 */
export function resolveSpawnCommand(
	explicitCommand: string | undefined,
	resume: ReturnType<typeof pickResumeSession>,
): { command: string; resumedSessionId?: string } {
	if (explicitCommand?.trim()) return { command: explicitCommand.trim() };
	if (resume && "id" in resume) {
		return {
			command: `pi --session ${resume.id}`,
			resumedSessionId: resume.id,
		};
	}
	return { command: "pi" };
}

/**
 * The resume fragment appended to the spawn message. A live resume
 * reads plainly; an idle resume is flagged as such and carries its
 * last-active age so a day-old session is not silently presented as
 * current. Several live sessions report the count; nothing
 * resumable yields no fragment.
 */
export function resumeMessage(
	resume: ReturnType<typeof pickResumeSession>,
	sessions: SessionView[],
	now: Date,
): string | undefined {
	if (resume && "id" in resume) {
		const picked = sessions.find((s) => s.id === resume.id);
		if (picked?.liveness === "idle") {
			const age = formatRelativeAge(picked.lastActivity, now);
			return `Resuming idle session ${resume.id}${age ? `, last active ${age}` : ""}.`;
		}
		return `Resuming session ${resume.id}.`;
	}
	if (resume && "ambiguous" in resume) {
		return `${resume.ambiguous.length} live sessions; started fresh, resume one explicitly if needed.`;
	}
	return undefined;
}

export async function spawn(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): Promise<QuestResult> {
	const layout = (params.layout ??
		params.action.replace(/^spawn-/, "")) as TerminalLayout;
	if (!(["tab", "pane", "window"] as TerminalLayout[]).includes(layout)) {
		return refuse(
			`Unknown layout "${layout}". Use spawn-tab, spawn-pane or spawn-window.`,
		);
	}
	const driver = await resolveDriver();
	if (!driver) {
		return refuse(
			"No terminal driver is available. Register one with `registerTerminalDriver` or seed the built-ins.",
		);
	}
	// An explicit `id:` lets the agent open a tab for
	// another quest without touching its own loaded state.
	// We resolve through discovery so a typo fails fast.
	const targetId = params.id ?? state.questId ?? undefined;
	if (!targetId) {
		return refuse("Load a quest first, or pass an explicit `id`.");
	}
	const entry = getQuestEntry(state, targetId);
	if (!entry) {
		return refuse(`No quest with id "${targetId}".`);
	}
	const questIdForSpawn = entry.doc.frontMatter.id;
	const fm = entry.doc.frontMatter;

	// Resolve the working directory: prefer a quest-owned
	// tree, then a recent session's cwd, then a tree's repo
	// root, then the quest dir. A recorded path that no
	// longer exists self-heals to the next candidate rather
	// than dropping the new terminal into home.
	const now = new Date();
	const snapshot = await buildSessionSnapshot(fm.sessions, { now });
	const sessions = fm.sessions.map((s) => deriveLiveness(s, snapshot));
	const resolved = resolveSpawnCwd({
		questDir: entry.dir,
		trees: fm.trees ?? [],
		sessions,
	});
	const cwd = params.cwd?.trim() || resolved.cwd;

	// Pick the session to resume, excluding the one doing the
	// spawning. pickResumeSession prefers a live session, falls back
	// to the most-recent idle one, and only reports ambiguity when
	// several are concurrently live; in that case spawn starts a
	// fresh pi and surfaces the choice rather than guessing.
	const currentId = currentSessionId(ctx, undefined);
	const resume = pickResumeSession(sessions.filter((s) => s.id !== currentId));
	const { command, resumedSessionId } = resolveSpawnCommand(
		params.command,
		resume,
	);

	// Pass the target quest id through to the spawned
	// process via an env var. The new pi's quest-workflow
	// extension reads this on session_start and uses it to
	// load the right quest, which in turn names the session
	// after the quest. A resumed session restores its own
	// loaded quest from history, but the env var is harmless
	// and covers a fresh pi.
	const env = { QUEST_WORKFLOW_AUTOLOAD_ID: questIdForSpawn };
	try {
		await driver.spawn({ layout, command, cwd, env });
	} catch (err) {
		return refuse(`Spawn failed via ${driver.id}: ${(err as Error).message}`);
	}

	let message = `Spawned a ${layout} via ${driver.id} in ${cwd} (${resolved.source}).`;
	if (resolved.healed) {
		message += ` A recorded path was missing; healed to this one.`;
	}
	// Only narrate resume when the spawn used pi's default command;
	// an explicit command overrides the resume decision, so the
	// idle/live/ambiguous note would not describe what actually ran.
	const resumeNote = params.command?.trim()
		? undefined
		: resumeMessage(resume, sessions, now);
	if (resumeNote) message += ` ${resumeNote}`;
	return ok(message, {
		driver: driver.id,
		layout,
		cwd,
		cwdSource: resolved.source,
		healed: resolved.healed ?? false,
		command,
		resumedSessionId,
		autoloadQuestId: questIdForSpawn,
	});
}
