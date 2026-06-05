/**
 * Session verbs: attach, detach, rename. Plus the
 * `spawn-*` verbs that open a new terminal tab, pane or
 * window via the registered terminal driver.
 */

import type { ToolContext } from "@mariozechner/pi-coding-agent";
import { sessionsDir } from "../../../lib/internal/paths.js";
import {
	pickResumeSession,
	resolveSpawnCwd,
} from "../../../lib/internal/quest/reopen.js";
import { deriveLiveness } from "../../../lib/internal/quest/session-liveness.js";
import type { QuestSession } from "../../../lib/quest/index.js";
import {
	resolveDriver,
	type TerminalLayout,
} from "../../../lib/terminal/index.js";
import {
	attachSessionToLoaded,
	detachSessionFromLoaded,
	renameSessionOnLoaded,
} from "../lifecycle.js";
import { getQuestEntry } from "../lookup.js";
import type { QuestState } from "../state.js";
import {
	currentSessionId,
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.js";

export function sessionAttach(
	state: QuestState,
	ctx: ToolContext,
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
	ctx: ToolContext,
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
	ctx: ToolContext,
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

export async function spawn(
	state: QuestState,
	ctx: ToolContext,
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
	const store = sessionsDir();
	const sessions = fm.sessions.map((s) => deriveLiveness(s, store, now));
	const resolved = resolveSpawnCwd({
		questDir: entry.dir,
		trees: fm.trees ?? [],
		sessions,
	});
	const cwd = params.cwd?.trim() || resolved.cwd;

	// Resume a real session when exactly one is live and it
	// is not the session doing the spawning. Several live
	// sessions are ambiguous: spawn a fresh pi and surface
	// the choice rather than guessing.
	const currentId = currentSessionId(ctx, undefined);
	const resume = pickResumeSession(sessions.filter((s) => s.id !== currentId));
	let command = params.command?.trim() || "pi";
	let resumedSessionId: string | undefined;
	if (!params.command && resume && "id" in resume) {
		resumedSessionId = resume.id;
		command = `pi --session ${resume.id}`;
	}

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
	if (resumedSessionId) {
		message += ` Resuming session ${resumedSessionId}.`;
	} else if (resume && "ambiguous" in resume) {
		message += ` ${resume.ambiguous.length} live sessions; started fresh, resume one explicitly if needed.`;
	}
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
