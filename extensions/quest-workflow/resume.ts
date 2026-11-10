/**
 * /quest-resume: carry on a session attached to the loaded quest.
 *
 * On pi it switches this pi to the session's log, as it always has. A
 * hosted conversation can't switch its own log, which the host owns, so
 * there it asks its realm's attended host to adopt the session (or finds
 * it already held) and says how to view it. The answer goes into the
 * conversation as well as a notice, since a host with no viewer attached
 * keeps no notice, and whoever opens the conversation later reads it.
 */

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { hosted, sessionEnv } from "../../lib/core/session/index.ts";
import { deriveLiveness } from "../../lib/internal/quest/session-liveness.ts";
import type { QuestSession } from "../../lib/quest/index.ts";
import { buildSessionSnapshot } from "./liveness.ts";
import { showLoaded } from "./lookup.ts";
import type { QuestState } from "./state.ts";
import { resumeInHost } from "./verbs/spawn-host.ts";

/** The custom message a hosted resume leaves in the asking conversation. */
export const RESUMED_MESSAGE = "quest-resume";

/** Handle `/quest-resume <session-id>` for the loaded quest. */
export async function resumeQuestSession(
	pi: ExtensionAPI,
	state: QuestState,
	args: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const sessionId = args?.trim();
	if (!sessionId) {
		ctx.ui.notify(
			"Usage: /quest-resume <session-id>. Run `quest recent` to list resumable sessions with their ids and resume commands.",
			"warning",
		);
		return;
	}
	if (!state.questId) {
		ctx.ui.notify(
			"No quest loaded. `quest load <id>` first, then /quest-resume.",
			"warning",
		);
		return;
	}
	// Only a session in the loaded quest's record, so nobody is sent to a
	// session outside its audit trail.
	const projection = await showLoaded(state);
	const session = (projection?.frontMatter.sessions ?? []).find(
		(s) => s.id === sessionId,
	);
	if (!session) {
		ctx.ui.notify(
			`Session ${sessionId} is not attached to ${state.questId}. Use \`quest session-attach\` to attach the current session, or \`quest show\` to see attached sessions.`,
			"warning",
		);
		return;
	}
	if (hosted()) {
		await resumeHosted(pi, state.questId, session, ctx);
		return;
	}
	await switchToSession(sessionId, ctx);
}

/** Ask the realm's host to carry the session on, and say what it did. */
async function resumeHosted(
	pi: ExtensionAPI,
	questId: string,
	session: QuestSession,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (session.id === ctx.sessionManager.getSessionId()) {
		ctx.ui.notify(
			`Session ${session.id} is this conversation already.`,
			"info",
		);
		return;
	}
	const snapshot = await buildSessionSnapshot([session]);
	const result = await resumeInHost({
		questId,
		session: deriveLiveness(session, snapshot),
		env: sessionEnv(ctx).snapshot(),
	});
	const said = result.ok ? result.message : result.guidance;
	const details = result.ok
		? { sessionId: session.id, adopted: false, ...result.details }
		: { sessionId: session.id, adopted: false, refused: true };
	pi.sendMessage(
		{ customType: RESUMED_MESSAGE, content: said, display: true, details },
		{ triggerTurn: false },
	);
	ctx.ui.notify(said, result.ok ? "info" : "warning");
}

/** Switch this pi to the session's log, which lives under this folder's logs. */
async function switchToSession(
	sessionId: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let sessions: { id: string; path: string }[];
	try {
		sessions = await SessionManager.list(ctx.cwd);
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Could not list sessions: ${why}`, "warning");
		return;
	}
	const hit = sessions.find((s) => s.id === sessionId);
	if (!hit) {
		ctx.ui.notify(
			`Session ${sessionId} not found on disk for ${ctx.cwd}. It may live under a different cwd; open pi in that directory and try again.`,
			"warning",
		);
		return;
	}
	await ctx.switchSession(hit.path);
}
