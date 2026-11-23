/**
 * The sessions a quest's front matter records: attaching one with the
 * identity a later reader probes, detaching it only by the process
 * that owns it, keeping it active on one quest at a time, and naming
 * it.
 */

import { discoverQuests } from "../../internal/quest/discovery/discovery.ts";
import { writtenAlike } from "../../internal/quest/documents/frontmatter.ts";
import {
	currentInstanceId,
	currentProcessIdentity,
} from "../../internal/quest/sessions/process-liveness.ts";
import type { QuestSession } from "../../quest/index.ts";
import { identifyCurrentTerminal } from "../../terminal/index.ts";
import { hosted } from "../session/host.ts";
import type { SessionRef } from "../session/identity.ts";
import { writeQuestFrontMatter } from "./front-matter.ts";
import type { QuestState } from "./state.ts";

/** Attach a session id to the loaded quest. */
export function attachSessionToLoaded(
	state: QuestState,
	session: QuestSession,
): { ok: true; added: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	return attachSessionInQuestDir(state.questDir, session);
}

/** Attach a session id to the quest in `questDir`, loaded or not. */
export function attachSessionInQuestDir(
	questDir: string,
	session: QuestSession,
): { ok: true; added: boolean } | { ok: false; guidance: string } {
	let added = false;
	const result = writeQuestFrontMatter(questDir, (fm) => {
		const existing = fm.sessions.find((s) => s.id === session.id);
		if (existing) {
			// Refresh status to active and merge any new fields, but keep
			// the original started: it records when the session first
			// touched this quest, not the latest attach. Letting the
			// incoming started win would defeat the no-op guard below and
			// churn the README on every load.
			const merged: QuestSession = {
				...existing,
				...session,
				started: existing.started ?? session.started,
				status: "active",
			};
			if (writtenAlike(merged, existing)) {
				return undefined;
			}
			return {
				...fm,
				sessions: fm.sessions.map((s) => (s.id === session.id ? merged : s)),
			};
		}
		added = true;
		const next: QuestSession = { status: "active", ...session };
		return { ...fm, sessions: [...fm.sessions, next] };
	});
	if (!result.ok) return result;
	return { ok: true, added };
}

/**
 * Capture the current process's liveness identity for a session
 * attach: its instance id, OS process identity and the terminal
 * surface it runs in (when a driver recognises one). Read once at
 * attach time; the stored handle is what a later reader probes.
 */
export function captureSessionIdentity(ref?: SessionRef): {
	instanceId: string;
	process: QuestSession["process"];
	terminal: QuestSession["terminal"];
} {
	const handle = hosted() ? undefined : identifyCurrentTerminal();
	return {
		instanceId: currentInstanceId(ref),
		process: currentProcessIdentity(ref),
		terminal: handle
			? {
					driverId: handle.driverId,
					value: handle.value,
					scope: handle.scope,
					hostId: handle.hostId,
				}
			: undefined,
	};
}

/**
 * Attach the current session to the loaded quest.
 *
 * This is the automatic-capture path: a session-start or load flow
 * calls it so a quest's sessions frontmatter records where work
 * happened without the user attaching by hand. It refreshes an
 * existing record rather than duplicating, and no-ops cleanly when
 * no quest is loaded or the session id is unknown.
 */
export function attachCurrentSession(
	state: QuestState,
	opts: {
		id: string | undefined;
		cwd?: string;
		persisted?: boolean;
		instanceId?: string;
		process?: QuestSession["process"];
		terminal?: QuestSession["terminal"];
	},
): { attached: boolean } {
	// An ephemeral session has an id but writes no log, so attaching it
	// would leave a phantom entry that can never be resumed. Skip it;
	// only a persisted session earns a record.
	if (opts.persisted === false) return { attached: false };
	if (!state.questDir || !opts.id) return { attached: false };
	const session: QuestSession = {
		id: opts.id,
		started: new Date().toISOString(),
		status: "active",
	};
	if (opts.cwd?.trim()) session.cwd = opts.cwd.trim();
	if (opts.instanceId) session.instanceId = opts.instanceId;
	if (opts.process) session.process = opts.process;
	if (opts.terminal) session.terminal = opts.terminal;
	const result = attachSessionToLoaded(state, session);
	return { attached: result.ok };
}

/**
 * Detach a session only when the caller's process instance owns the
 * record, so a process that resumed a session is not detached by the
 * delayed shutdown of the process that used to hold it. A record with
 * no recorded instance id is legacy and detaches unconditionally,
 * preserving the pre-lease behaviour.
 */
export function detachSessionIfOwner(
	questDir: string,
	sessionId: string,
	instanceId: string,
): { ok: true; detached: boolean } | { ok: false; guidance: string } {
	let detached = false;
	const result = writeQuestFrontMatter(questDir, (fm) => {
		let hit = false;
		const next = fm.sessions.map((s) => {
			if (s.id !== sessionId || s.status === "detached") return s;
			// A different live instance owns the record: leave it be.
			if (s.instanceId !== undefined && s.instanceId !== instanceId) return s;
			hit = true;
			return { ...s, status: "detached" as const };
		});
		if (!hit) return undefined;
		detached = true;
		return { ...fm, sessions: next };
	});
	if (!result.ok) return result;
	return { ok: true, detached };
}

/** Mark a session as detached on the loaded quest. */
export function detachSessionFromLoaded(
	state: QuestState,
	sessionId: string,
): { ok: true; detached: boolean } | { ok: false; guidance: string } {
	if (!state.questDir) return { ok: false, guidance: "Load a quest first." };
	return detachSessionInQuestDir(state.questDir, sessionId);
}

/**
 * Reconcile a session's membership so it reads active on exactly one
 * quest: detach the session from every quest other than the one being
 * kept. The switch path already releases the immediate prior quest;
 * this catches stragglers left by earlier runs or a lost state, so a
 * session never lingers active on several quests at once. Returns the
 * ids it detached the session from.
 */
export function reconcileSessionMembership(
	state: QuestState,
	sessionId: string,
	keepQuestId: string,
): string[] {
	const { index } = discoverQuests(state.questsRoot);
	const detachedFrom: string[] = [];
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		if (fm.id === keepQuestId) continue;
		const holdsActive = fm.sessions.some(
			(s) => s.id === sessionId && s.status !== "detached",
		);
		if (!holdsActive) continue;
		const result = detachSessionInQuestDir(entry.dir, sessionId);
		if (result.ok && result.detached) detachedFrom.push(fm.id);
	}
	return detachedFrom;
}

/**
 * Mark a session detached on the quest in `questDir`, loaded or not,
 * whichever process holds it. Answers whether a record changed.
 */
export function detachSessionInQuestDir(
	questDir: string,
	sessionId: string,
): { ok: true; detached: boolean } | { ok: false; guidance: string } {
	let detached = false;
	const result = writeQuestFrontMatter(questDir, (fm) => {
		let hit = false;
		const next = fm.sessions.map((s) => {
			if (s.id !== sessionId) return s;
			if (s.status === "detached") return s;
			hit = true;
			return { ...s, status: "detached" as const };
		});
		if (!hit) return undefined;
		detached = true;
		return { ...fm, sessions: next };
	});
	if (!result.ok) return result;
	return { ok: true, detached };
}

/** Rename a session on the quest in `questDir`, loaded or not. */
export function renameSessionInQuestDir(
	questDir: string,
	sessionId: string,
	name: string,
): { ok: true; renamed: boolean } | { ok: false; guidance: string } {
	let renamed = false;
	const result = writeQuestFrontMatter(questDir, (fm) => {
		let hit = false;
		const next = fm.sessions.map((s) => {
			if (s.id !== sessionId) return s;
			if (s.name === name) return s;
			hit = true;
			return { ...s, name };
		});
		if (!hit) return undefined;
		renamed = true;
		return { ...fm, sessions: next };
	});
	if (!result.ok) return result;
	return { ok: true, renamed };
}
