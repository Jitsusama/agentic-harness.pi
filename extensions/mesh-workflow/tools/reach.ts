/**
 * Who a message reaches: the peers it wakes, those it can't, and what
 * the sender is told of each.
 */

import { isAddress } from "../../../lib/mesh/address.ts";
import { homeOf } from "../../../lib/mesh/group.ts";
import type { Census } from "../../../lib/mesh/liveness.ts";
import { clock, type Message, reaches } from "../../../lib/mesh/message.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import type { Reader } from "../../../lib/mesh/thread.ts";
import { type Refusal, refusedNotes } from "../refusals.ts";
import { WANTING } from "./said.ts";

/**
 * The peers' home groups among `groups` that no session in this mesh
 * goes by, there or ended. The node writes the presence of every
 * session in this realm here, those on other machines too, so such an
 * address is mistyped or belongs to a realm kept apart from this one.
 * `known` names homes heard of otherwise, as a message's sender.
 */
export function unheardOf(
	groups: readonly string[],
	standing: Census,
	known: readonly string[] = [],
): string[] {
	const homes = new Set([
		...known,
		...[...standing.present, ...standing.gone].flatMap((one) =>
			one.addresses.map(homeOf),
		),
	]);
	return groups.filter((group) => group.startsWith("@") && !homes.has(group));
}

/**
 * The address a sender is told a peer goes by. A presence's addresses
 * are read only in an address's shape (lib/mesh/presence.ts), which
 * `person` and `machine` have too, and each note opens on this one, so
 * a peer that names no address is left unnamed.
 */
function told(one: Presence): string | undefined {
	return one.addresses.find(isAddress);
}

/**
 * Peers said by the addresses they are told by, then how many named
 * none, as "WCJQSG, P9R1KI and 1 peer naming no address", so a peer
 * left unnamed is still counted and never reads as nobody. Said where
 * it `opens` a sentence, it opens on a capital either way.
 */
export function peersNamed(
	addresses: readonly (string | undefined)[],
	opens = true,
): string {
	const named = addresses.filter(
		(address): address is string => address !== undefined,
	);
	const unnamed = addresses.length - named.length;
	const nameless =
		unnamed === 0
			? ""
			: `${unnamed === 1 ? "a peer" : `${unnamed} peers`} naming no address`;
	if (named.length === 0 && opens) {
		return `${nameless.charAt(0).toUpperCase()}${nameless.slice(1)}`;
	}
	return [named.join(", "), nameless].filter(Boolean).join(" and ");
}

/** Who a message just sent goes to, and which addressed peers it misses. */
export function reach(
	message: Message,
	standing: Census,
	peer: Peer,
	read: Reader,
	refusal: Refusal,
): { notes: string[]; reached: string[]; gone: string[] } {
	const everyone = standing.present;
	const reaching = everyone
		.filter((one) => one.session !== peer.session)
		.filter((one) => reaches(message, one, -1));
	const reached = reaching.flatMap((one) => told(one) ?? []);
	const homes = (list: readonly Presence[]) =>
		new Set(list.flatMap((one) => one.addresses.map(homeOf)));
	const there = homes(everyone);
	const ended = homes(standing.gone);
	const addressed = message.to.filter((group) => group.startsWith("@"));
	const gone = addressed
		.filter((group) => !there.has(group) && ended.has(group))
		.map((group) => group.slice(1));
	const unknown = unheardOf(addressed, standing).map((group) => group.slice(1));
	// Waited on as though it were free to answer, it would hold its asker up.
	const waiting = everyone.flatMap((one) => {
		const address = told(one);
		return one.session !== peer.session &&
			one.wants &&
			address !== undefined &&
			one.addresses.some((each) => addressed.includes(homeOf(each)))
			? [
					`${address} (${WANTING[one.wants.kind]} since ${clock({ at: one.wants.since })})`,
				]
			: [];
	});
	const idle = idleAddressed(message, everyone, peer, addressed, read);
	const refused = refusedNotes(
		everyone.filter(
			(one) =>
				one.session !== peer.session &&
				one.addresses.some((address) => addressed.includes(homeOf(address))),
		),
		refusal,
	);
	const notes = [
		reaching.length > 0
			? `It goes to ${peersNamed(reaching.map(told), false)}; mesh_read says when each has it.`
			: "No peer on the mesh is reached by it yet.",
		gone.length > 0
			? `${gone.join(", ")} ${gone.length === 1 ? "has" : "have"} ended, so ${gone.length === 1 ? "it hears" : "they hear"} this only if restored.`
			: "",
		unknown.length > 0
			? `No peer goes by ${unknown.join(", ")}; one never will if the address is wrong.`
			: "",
		waiting.length > 0
			? `${waiting.join(" and ")} ${waiting.length === 1 ? "is waiting on its person, so it" : "are waiting on their people, so they"} may be slow to take this up.`
			: "",
		idle.length > 0 ? idleText(idle, message.intent) : "",
		...refused,
	].filter(Boolean);
	return { notes, reached, gone };
}

/** A peer an fyi or finding was put to that no run will read it in. */
interface Unwoken {
	readonly address: string;
	/** Whether this peer orchestrates it, so a pivot would start its turn. */
	readonly led: boolean;
}

/**
 * The idle peers an fyi or finding is addressed to that it starts no
 * turn for. On 9 November builders sat idle on fyis their orchestrator
 * meant them to act on, since a note waits for a turn something else
 * starts (lib/mesh/attention.ts). An idle orchestrator acts on what a
 * session it leads sends, so it is left out, as is a peer waiting on
 * its person, which the note before says already, and one whose own
 * question this answers, which takes its turn however it is sent.
 */
function idleAddressed(
	message: Message,
	everyone: readonly Presence[],
	peer: Peer,
	addressed: readonly string[],
	read: Reader,
): Unwoken[] {
	if (message.intent !== "fyi" && message.intent !== "finding") return [];
	const asked = message.re === undefined ? undefined : read(message.re);
	const asker = asked?.intent === "question" ? asked.from : undefined;
	return everyone.flatMap((one) => {
		const address = told(one);
		if (
			address === undefined ||
			one.session === peer.session ||
			one.busy ||
			one.wants ||
			(asker !== undefined && one.addresses.includes(asker)) ||
			!one.addresses.some((each) => addressed.includes(homeOf(each)))
		) {
			return [];
		}
		const leadsThis =
			peer.orchestratedBy !== undefined &&
			one.addresses.includes(peer.orchestratedBy);
		if (leadsThis) return [];
		const led =
			one.orchestratedBy !== undefined &&
			peer.addresses.includes(one.orchestratedBy);
		return [{ address, led }];
	});
}

/** Why an fyi or finding to idle peers waits, and what would wake them. */
function idleText(idle: readonly Unwoken[], intent: string): string {
	const one = idle.length === 1;
	const names = idle.map((each) => each.address).join(" and ");
	const wake = idle.every((each) => each.led)
		? "a question or a pivot"
		: "a question";
	return `${names} ${one ? "is" : "are"} idle, and ${intent === "fyi" ? "an fyi" : "a finding"} starts no turn, so ${one ? "it reads" : "they read"} this only when something else starts ${one ? "its" : "their"} next. Send ${wake} if ${one ? "it" : "they"} should act on it now.`;
}
