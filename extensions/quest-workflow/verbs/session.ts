/**
 * Session verbs: attach, detach, rename. Plus the
 * `spawn-*` verbs that open a new terminal tab, pane or
 * window via the registered terminal driver.
 */

import type { ToolContext } from "@mariozechner/pi-coding-agent";
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
	// We resolve through discovery so a typo fails fast,
	// and we inherit the target quest's dir for the new
	// process's cwd unless the caller overrode it.
	let questIdForSpawn: string | undefined = state.questId ?? undefined;
	let defaultCwd: string | undefined = state.questDir ?? undefined;
	if (params.id) {
		const entry = getQuestEntry(state, params.id);
		if (!entry) {
			return refuse(`No quest with id "${params.id}".`);
		}
		questIdForSpawn = entry.doc.frontMatter.id;
		defaultCwd = entry.dir;
	}
	const cwd = params.cwd?.trim() || defaultCwd || undefined;
	const command = params.command?.trim() || "pi";
	// Pass the target quest id through to the spawned
	// process via an env var. The new pi's quest-workflow
	// extension reads this on session_start and uses it
	// to load the right quest, which in turn calls
	// pi.setSessionName so the new session inherits the
	// quest's name without depending on terminal-emulator
	// tab titles. The auto-attach on cwd already handles
	// the common case where the spawn lands inside a
	// registered tree; this env var carries the id when
	// the cwd doesn't help (e.g. a fresh sidequest with
	// no tree of its own).
	const env = questIdForSpawn
		? { QUEST_WORKFLOW_AUTOLOAD_ID: questIdForSpawn }
		: undefined;
	try {
		await driver.spawn({ layout, command, cwd, env });
	} catch (err) {
		return refuse(`Spawn failed via ${driver.id}: ${(err as Error).message}`);
	}
	return ok(`Spawned a ${layout} via ${driver.id}.`, {
		driver: driver.id,
		layout,
		cwd,
		command,
		autoloadQuestId: questIdForSpawn,
	});
}
