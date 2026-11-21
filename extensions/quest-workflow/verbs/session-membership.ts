/**
 * Session membership verbs: which sessions a quest counts as its own,
 * attached, detached, renamed, and the audit that repairs a session
 * counted on more than one quest. Spawning a session is session.ts's.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestSession } from "../../../lib/quest/index.ts";
import { count } from "../../../lib/ui/count.ts";
import {
	attachSessionInQuestDir,
	captureSessionIdentity,
	detachSessionInQuestDir,
	reconcileSessionMembership,
	renameSessionInQuestDir,
} from "../lifecycle.ts";
import {
	auditSessionMembership,
	getQuestEntry,
	planDeadSessions,
	planSessionRepair,
} from "../lookup.ts";
import type { QuestState } from "../state.ts";
import { addressOf } from "./address.ts";
import {
	currentSessionId,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

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
	// A session whose claims are conflicted is left for the user to
	// resolve by loading its true quest; the dead pass must respect that
	// same rule, so a dead-and-conflicted session is not force-detached
	// out from under the unresolved decision.
	const conflictedIds = new Set(plan.conflicted.map((d) => d.sessionId));
	const dead = (await planDeadSessions(state)).filter(
		(d) => !conflictedIds.has(d.sessionId),
	);
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
		`Repaired ${count(plan.resolvable.length, "divergent session")}, detached ${count(detached, "stray membership")}; detached ${count(deadDetached, "dead session")}. ${count(plan.conflicted.length, "conflicted record")} left untouched.`,
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

/**
 * The quest a session verb acts on: the one `id` names, loaded or not,
 * or else the loaded one. On 29 October a detach naming another quest
 * acted on the loaded one and found nothing, leaving the session active
 * on the quest it had left.
 */
function sessionQuest(
	state: QuestState,
	params: QuestToolParams,
): { questId: string; questDir: string } | { refusal: string } {
	if (!params.id?.trim() && !state.questId) {
		return { refusal: "Load a quest first, or name it as `id`." };
	}
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return target;
	return { questId: target.questId, questDir: target.questDir };
}

export function sessionAttach(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	const quest = sessionQuest(state, params);
	if ("refusal" in quest) return refuse(quest.refusal);
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
	// Capture liveness identity only when attaching this process's own
	// session; an explicit sessionId for another session must not be
	// tagged with our process and terminal.
	if (id === currentSessionId(ctx, undefined)) {
		const identity = captureSessionIdentity();
		session.instanceId = identity.instanceId;
		if (identity.process) session.process = identity.process;
		if (identity.terminal) session.terminal = identity.terminal;
	}
	const result = attachSessionInQuestDir(quest.questDir, session);
	if (!result.ok) return refuse(result.guidance);
	return ok(
		result.added
			? `Attached session ${id} to ${quest.questId}.`
			: `Session ${id} was already attached to ${quest.questId}; refreshed status.`,
		{ session, added: result.added },
	);
}

export function sessionDetach(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	const quest = sessionQuest(state, params);
	if ("refusal" in quest) return refuse(quest.refusal);
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) {
		return refuse(
			"Could not determine session id to detach. Pass it explicitly in `sessionId`.",
		);
	}
	const result = detachSessionInQuestDir(quest.questDir, id);
	if (!result.ok) return refuse(result.guidance);
	if (!result.detached) {
		return refuse(
			`Session ${id} is not attached (or already detached) on ${quest.questId}.`,
		);
	}
	return ok(`Detached session ${id} from ${quest.questId}.`, {
		sessionId: id,
	});
}

export function sessionRename(
	state: QuestState,
	ctx: ExtensionContext,
	params: QuestToolParams,
): QuestResult {
	const quest = sessionQuest(state, params);
	if ("refusal" in quest) return refuse(quest.refusal);
	if (!params.name?.trim())
		return refuse("Pass the new session name in `name`.");
	const id = currentSessionId(ctx, params.sessionId);
	if (!id) return refuse("Pass a session id in `sessionId`.");
	const result = renameSessionInQuestDir(
		quest.questDir,
		id,
		params.name.trim(),
	);
	if (!result.ok) return refuse(result.guidance);
	if (!result.renamed) {
		return refuse(
			`Session ${id} is not attached to ${quest.questId} or already has that name.`,
		);
	}
	return ok(`Renamed session ${id} to "${params.name.trim()}".`, {
		sessionId: id,
		name: params.name.trim(),
	});
}
