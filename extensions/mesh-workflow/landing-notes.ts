/**
 * What the mesh tells a repository's network by itself when a session
 * merges a change there: one line naming the change, what it is, what
 * it means to the person when the merge said so, and where to open it.
 *
 * Notes of a landed change went up to orchestrators by hand, 220 of
 * them on Sunday 15 November, so one conversation heard every landing
 * of its whole tree. The sessions a change touches are the ones working
 * in its repository, who rebase over it, so the note goes to that
 * network, `#repo/<name>`, the group each is in by its work (scope.ts).
 * Joel reads landings in the launcher's Landed, from the session's
 * presence, so nothing here goes to him or to an orchestrator
 * (QEST-20261115-FZ9MFJ, "A Web, Not a Funnel").
 *
 * A plan item ticked is the session's own progress and tells nobody.
 */

import type { Landing } from "../../lib/internal/session/landings.ts";
import type { Message } from "../../lib/mesh/message.ts";
import { senderIdentity } from "../../lib/mesh/message.ts";
import type { Peer } from "../../lib/mesh/peer.ts";
import { repositoryGroup } from "../../lib/mesh/scope.ts";
import type { Transport } from "../../lib/mesh/transport.ts";

/** A plan document's id, which a ticked item's ref opens with. */
const DOCUMENT_ID = /^[A-Z]+-\d{8}-[A-Z0-9]+$/;

/** The longest a landing's own words are quoted at. */
const SAID_CHARS = 240;

/**
 * The repository network a landing is told to: a change merged, named
 * `repo#number`, to `#repo/<repo>`; nothing for a plan item or any
 * other ref.
 */
export function repositoryOf(landing: Landing): string | undefined {
	const hash = landing.ref.lastIndexOf("#");
	if (hash <= 0) return undefined;
	const repository = landing.ref.slice(0, hash);
	if (DOCUMENT_ID.test(repository)) return undefined;
	if (!/^\d+$/.test(landing.ref.slice(hash + 1))) return undefined;
	return repositoryGroup(repository);
}

/**
 * Tell the network of the repository `landing` merged into that it
 * landed, as an fyi signed by `peer`; nothing for a landing that names
 * no change, or one this peer already said landed, as a merge said
 * again when its queue settles.
 */
export function tellRepository(
	peer: Peer,
	transport: Transport,
	landing: Landing,
): Message | undefined {
	const group = repositoryOf(landing);
	if (!group) return undefined;
	if (peer.landings.some((one) => one.ref === landing.ref)) return undefined;
	const said = [
		`${peer.signature} landed ${landing.ref}, ${quoted(landing.what)}.`,
		...(landing.person ? [`For the person: ${quoted(landing.person)}.`] : []),
		...(landing.url ? [landing.url] : []),
		`Said by the mesh; feedback to ${peer.signature}.`,
	];
	return transport.send({
		from: peer.signature,
		to: [group],
		intent: "fyi",
		text: said.join(" "),
		...senderIdentity(),
	});
}

function quoted(said: string): string {
	const line = said.replace(/\s+/g, " ").trim().replace(/\.$/, "");
	return line.length <= SAID_CHARS
		? line
		: `${line.slice(0, SAID_CHARS - 1).trimEnd()}\u2026`;
}
