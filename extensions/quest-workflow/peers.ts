/**
 * Other live pi sessions on the quest this one is loading.
 *
 * Two tabs on one quest write the same README, the same plan and the
 * same trees, and neither knows about the other: one tab's stage
 * change, Journey line or commit lands under the other's feet. Nothing
 * stops that, and nothing should, since two tabs on one quest can be
 * deliberate. But it should never be a surprise, so loading a quest
 * says who else is on it.
 *
 * Only a session whose recorded process still runs counts. Recency
 * and terminal panes are left out on purpose: a stale record named as
 * a live peer would teach people to ignore the notice.
 */

import { hostname } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	localProcessDeps,
	type ProbeProcessDeps,
	probeProcess,
} from "../../lib/internal/quest/process-liveness.ts";
import type { QuestSession } from "../../lib/quest/index.ts";
import { findQuestEntry } from "./lifecycle.ts";
import type { QuestState } from "./state.ts";

/** The customType of the message naming a quest's peers. */
const PEERS_MESSAGE = "quest-workflow-peers";

/**
 * On startup, tell the model and the person who else is on the quest
 * this session resumed onto. Call before the session attaches. A reload
 * finds the same notice already in the session and says nothing.
 */
export function sayPeersOnStartup(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	if (!state.questId) return;
	const sessions =
		findQuestEntry(state, state.questId)?.doc.frontMatter.sessions ?? [];
	const said = peersSaid(state.questId, livePeers(sessions));
	if (!said) return;
	const already = ctx.sessionManager
		.getEntries()
		.some(
			(e) =>
				e.type === "custom_message" &&
				e.customType === PEERS_MESSAGE &&
				e.content === said,
		);
	if (already) return;
	pi.sendMessage({ customType: PEERS_MESSAGE, content: said, display: false });
	if (ctx.hasUI) ctx.ui.notify(said, "warning");
}

/** A session attached to the quest whose process is running elsewhere. */
export interface Peer {
	id: string;
	cwd?: string;
	pid: number;
}

/**
 * The sessions on a quest whose process is alive and is not this one.
 * A session with this process's pid is this tab, whichever session it
 * is now running; the same session id under another live process is a
 * peer, since that is the same conversation open twice.
 */
export function livePeers(
	sessions: readonly QuestSession[],
	self: { pid: number; hostId: string } = {
		pid: process.pid,
		hostId: hostname(),
	},
	deps: ProbeProcessDeps = localProcessDeps(),
): Peer[] {
	const peers: Peer[] = [];
	for (const session of sessions) {
		const proc = session.process;
		if (session.status === "detached" || !proc) continue;
		if (proc.pid === self.pid && proc.hostId === self.hostId) continue;
		if (probeProcess(proc, deps) !== "matching") continue;
		peers.push({
			id: session.id,
			...(session.cwd ? { cwd: session.cwd } : {}),
			pid: proc.pid,
		});
	}
	return peers;
}

/** One sentence naming the peers on a quest, or nothing when there are none. */
export function peersSaid(
	questId: string,
	peers: readonly Peer[],
): string | undefined {
	if (peers.length === 0) return undefined;
	const named = peers
		.map((p) => `session ${p.id}${p.cwd ? ` in ${p.cwd}` : ""} (pid ${p.pid})`)
		.join(", ");
	const who =
		peers.length === 1
			? "Another live pi session is"
			: `${peers.length} other live pi sessions are`;
	return `${who} on ${questId}: ${named}. Its writes to this quest's README, plans and trees can land under yours; coordinate, or work in one of them.`;
}
