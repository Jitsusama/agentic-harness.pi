/**
 * What the mesh tells a session's orchestrator by itself, with no model
 * involved: that a quest or document it runs was concluded or retired.
 *
 * An orchestrator learned a plan was done only when the session that
 * did it remembered to say so, and the summaries it kept for Joel fell
 * behind. The quest workflow says each ending on pi's bus
 * (lib/internal/quest/concluded.ts); this sends it on, one line, to the
 * orchestrator's home group, as an fyi.
 */

import type { ConcludedEvent } from "../../lib/internal/quest/concluded.ts";
import { homeOf } from "../../lib/mesh/group.ts";
import type { Message } from "../../lib/mesh/message.ts";
import type { Peer } from "../../lib/mesh/peer.ts";
import type { Transport } from "../../lib/mesh/transport.ts";

/** The longest the quest tool's answer is quoted at. */
const SAID_CHARS = 240;

/**
 * Tell this peer's orchestrator that something ended, and answer the
 * message sent; nothing, when no orchestrator is above its quest.
 */
export function tellOrchestrator(
	peer: Peer | undefined,
	transport: Transport,
	event: ConcludedEvent,
): Message | undefined {
	const orchestrator = peer?.orchestratedBy;
	if (!peer || !orchestrator) return undefined;
	return transport.send({
		from: peer.signature,
		to: [homeOf(orchestrator)],
		intent: "fyi",
		text: `${peer.signature}, said by the mesh: ${event.ids.join(", ") || "its quest"} ${event.how}. ${quoted(event.said)}`,
		pid: process.pid,
	});
}

function quoted(said: string): string {
	const line = said.replace(/\s+/g, " ").trim();
	return line.length <= SAID_CHARS
		? line
		: `${line.slice(0, SAID_CHARS - 1).trimEnd()}\u2026`;
}
