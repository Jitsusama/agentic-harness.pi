/**
 * What the mesh tells a session's orchestrator by itself, with no model
 * involved: that a quest or document it runs was concluded or retired,
 * or that the session is on no model and so can't answer.
 *
 * An orchestrator learned a plan was done only when the session that
 * did it remembered to say so, and the summaries it kept for Joel fell
 * behind. The quest workflow says each ending on pi's bus
 * (lib/internal/quest/fields/concluded.ts); this sends it on, one line, to the
 * orchestrator's home group, as an fyi.
 *
 * Where the quest carries no mark, the one told is its hub from use
 * (tools/above.ts), the cell above it its own talk has chosen, so a
 * quest needs no orchestration for its endings to be heard.
 */

import type { ConcludedEvent } from "../../lib/internal/quest/fields/concluded.ts";
import type { NoModelEvent } from "../../lib/internal/session/no-model.ts";
import { homeOf } from "../../lib/mesh/group.ts";
import type { Message } from "../../lib/mesh/message.ts";
import { senderIdentity } from "../../lib/mesh/message.ts";
import type { Peer } from "../../lib/mesh/peer.ts";
import type { Presence } from "../../lib/mesh/presence.ts";
import { stoppedBy } from "../../lib/mesh/stop.ts";
import type { Transport } from "../../lib/mesh/transport.ts";

/** The longest the quest tool's answer is quoted at. */
const SAID_CHARS = 240;

/**
 * Tell `above`, this peer's orchestrator or its hub from use, that
 * something ended, and answer the message sent; nothing, when nobody is
 * above its quest or the one above has stopped this peer, since a stop
 * is absolute.
 */
export function tellOrchestrator(
	peer: Peer | undefined,
	above: string | undefined,
	transport: Transport,
	event: ConcludedEvent,
	everyone: readonly Presence[],
): Message | undefined {
	return told(
		peer,
		above,
		transport,
		everyone,
		"fyi",
		`${event.ids.join(", ") || "its quest"} ${event.how}. ${quoted(event.said)}`,
	);
}

/**
 * Tell `above`, as a finding, that this peer's session is on no model
 * and so answers nothing it is sent, until someone chooses one in its
 * window or starts it again; nothing, as `tellOrchestrator`.
 */
export function tellOnNoModel(
	peer: Peer | undefined,
	above: string | undefined,
	transport: Transport,
	event: NoModelEvent,
	everyone: readonly Presence[],
): Message | undefined {
	const had = event.model
		? ` It ran on ${event.model}, which can't be set back: ${quoted(event.why ?? "unknown")}.`
		: "";
	return told(
		peer,
		above,
		transport,
		everyone,
		"finding",
		`this session is on no model, so it answers nothing.${had} It needs a model chosen with /model in its window, or a restart.`,
	);
}

function told(
	peer: Peer | undefined,
	orchestrator: string | undefined,
	transport: Transport,
	everyone: readonly Presence[],
	intent: "fyi" | "finding",
	said: string,
): Message | undefined {
	if (!peer || !orchestrator) return undefined;
	const stopped = stoppedBy(peer, everyone).some(({ stopper }) =>
		stopper.addresses.includes(orchestrator),
	);
	if (stopped) return undefined;
	return transport.send({
		from: peer.signature,
		to: [homeOf(orchestrator)],
		intent,
		text: `${peer.signature}, said by the mesh: ${said}`,
		...senderIdentity(),
	});
}

function quoted(said: string): string {
	const line = said.replace(/\s+/g, " ").trim();
	return line.length <= SAID_CHARS
		? line
		: `${line.slice(0, SAID_CHARS - 1).trimEnd()}\u2026`;
}
