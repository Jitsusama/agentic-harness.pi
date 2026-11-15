/**
 * Which quests a session belongs to, checked against what is true: a
 * session listed active on more than one quest, one a probe reads dead,
 * and how the session's own log settles which quest keeps it. Read-only;
 * the session verbs act on what this plans.
 */

import { sessionsDir } from "../../../lib/internal/paths.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import {
	deriveLiveness,
	indexSessionFiles,
} from "../../../lib/internal/quest/session-liveness.ts";
import { authoritativeQuestFromLog } from "../../../lib/internal/quest/session-ownership.ts";
import { buildSessionSnapshot } from "../liveness.ts";
import type { QuestState } from "../state.ts";

/** A session listed active on more than one quest. */
export interface SessionDivergence {
	sessionId: string;
	questIds: string[];
}

/**
 * Scan the store for session-to-quest divergence: a session id that
 * reads active on more than one quest at once. Reconcile-on-load
 * repairs this the moment a session loads a quest, but until then an
 * operator has no way to see it; this surfaces it read-only, without
 * loading or mutating anything. A single-membership store returns an
 * empty list.
 */
export function auditSessionMembership(state: QuestState): SessionDivergence[] {
	const { index } = discoverQuests(state.questsRoot);
	const bySession = new Map<string, string[]>();
	for (const entry of index.quests.values()) {
		for (const s of entry.doc.frontMatter.sessions) {
			// A missing status reads as active, matching how the rest of
			// the code treats legacy records, so a status-less duplicate is
			// still caught as a conflict.
			if ((s.status ?? "active") === "active") {
				const list = bySession.get(s.id) ?? [];
				list.push(entry.doc.frontMatter.id);
				bySession.set(s.id, list);
			}
		}
	}
	const divergences: SessionDivergence[] = [];
	for (const [sessionId, questIds] of bySession) {
		if (questIds.length > 1) {
			divergences.push({ sessionId, questIds: questIds.sort() });
		}
	}
	return divergences;
}

/** An active session a probe reads provably dead. */
export interface DeadSession {
	sessionId: string;
	questId: string;
}

/**
 * Active sessions whose captured process or terminal identity a probe
 * reads gone. Only identity-bearing records qualify: with identity,
 * `deriveLiveness` judges by observation, so "dead" means a real probe
 * saw the process gone or the pane absent. A record with no identity
 * is dead only by the recency heuristic, which is too uncertain to
 * act on, so it is never listed. Async because it probes once over a
 * snapshot; read-only.
 */
export async function planDeadSessions(
	state: QuestState,
): Promise<DeadSession[]> {
	const { index } = discoverQuests(state.questsRoot);
	const claims = [...index.quests.values()].flatMap((entry) =>
		entry.doc.frontMatter.sessions
			.filter((s) => (s.status ?? "active") === "active")
			.map((session) => ({ entry, session })),
	);
	const snapshot = await buildSessionSnapshot(claims.map((c) => c.session));
	const dead: DeadSession[] = [];
	for (const { entry, session } of claims) {
		// Only a captured identity makes "dead" a probe verdict rather
		// than the recency heuristic, so an identity-less record is never
		// a detach candidate here.
		if (!session.process && !session.terminal) continue;
		if (deriveLiveness(session, snapshot).liveness === "dead") {
			dead.push({
				sessionId: session.id,
				questId: entry.doc.frontMatter.id,
			});
		}
	}
	return dead;
}

/** One divergent session the repair can resolve from its log. */
export interface ResolvableSession {
	sessionId: string;
	/** The quest the session's log names as its owner; the one kept. */
	keep: string;
	/** The quests to detach the session from. */
	detachFrom: string[];
}

/** A repair plan for the store's session-to-quest divergence. */
export interface SessionRepairPlan {
	resolvable: ResolvableSession[];
	conflicted: SessionDivergence[];
}

/**
 * Plan how to repair sessions active on more than one quest. The
 * session's own log is the authority: when its last quest-workflow
 * entry names one of the claimants, that quest is kept and the others
 * are planned for detach. When the log is missing, cleared, or names
 * a quest that is not a claimant, the divergence cannot be resolved
 * from authority and is reported conflicted, never auto-assigned.
 * Read-only: it computes the plan and mutates nothing.
 */
export function planSessionRepair(state: QuestState): SessionRepairPlan {
	const divergences = auditSessionMembership(state);
	const logIndex = indexSessionFiles(sessionsDir());
	const resolvable: ResolvableSession[] = [];
	const conflicted: SessionDivergence[] = [];
	for (const divergence of divergences) {
		const logPath = logIndex.get(divergence.sessionId);
		const owner = logPath ? authoritativeQuestFromLog(logPath) : undefined;
		if (owner && divergence.questIds.includes(owner)) {
			resolvable.push({
				sessionId: divergence.sessionId,
				keep: owner,
				detachFrom: divergence.questIds.filter((id) => id !== owner),
			});
		} else {
			conflicted.push(divergence);
		}
	}
	return { resolvable, conflicted };
}
