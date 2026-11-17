/**
 * mesh_read: the latest messages this peer hears, within a budget, or
 * every question still waiting on a peer it was put to.
 */

import { homeOf } from "../../../lib/mesh/group.ts";
import { othersOn } from "../../../lib/mesh/lease.ts";
import {
	clock,
	line,
	type Message,
	reaches,
	senderIdentity,
	shortId,
} from "../../../lib/mesh/message.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import { idNamed, mayReplace, sentBy } from "../../../lib/mesh/thread.ts";
import { readEachOff } from "../../../lib/mesh/transport.ts";
import {
	UNANSWERED_WITHIN_MS,
	unanswered,
	withinOrchestration,
} from "../../../lib/mesh/unanswered.ts";
import { count } from "../../../lib/ui/count.ts";
import { refusedMark } from "../refusals.ts";
import { type Answer, answer, type Local, peers } from "./local.ts";
import { capitalized, since } from "./said.ts";

/** The most messages one mesh_read hands back. */
export const MOST_READ = 50;

/**
 * The most one mesh_read answer spends on messages, newest kept first.
 * Messages are short by request, yet with their receipts fifty came to
 * 30 KB, and seven answers between 24 and 26 October ran past 20 KB.
 * What is left out is read on with `before`, rather than stored.
 */
const READ_BUDGET_BYTES = 12_288;

export async function read(
	at: Local,
	params: { count?: number; unanswered?: boolean; before?: string },
): Promise<Answer> {
	if (params.unanswered) return answer(await openText(at));
	const wanted = Math.min(
		MOST_READ,
		Math.max(1, Math.floor(params.count ?? 15)),
	);
	// Newest first, reading only until enough are found: what is shown,
	// not the mesh's whole week. Off the thread, since in a host every
	// conversation waits on it while the disk answers.
	const ids = await at.transport.listAllIds();
	const before = params.before ? idNamed(params.before, ids) : undefined;
	if (params.before && before === undefined) {
		return answer(
			`No message has the id ${params.before}, so there is nothing to read before it. mesh_read shows each message's id in brackets.`,
		);
	}
	const from = before === undefined ? ids.length : ids.indexOf(before);
	const latest: Message[] = [];
	for (let index = from - 1; index >= 0; index--) {
		if (latest.length >= wanted) break;
		const message = await at.transport.readOff(ids[index] as string);
		if (
			message &&
			(sentBy(message, { addresses: at.peer.addresses, ...senderIdentity() }) ||
				reaches(message, at.peer.listener, -1))
		) {
			latest.unshift(message);
		}
	}
	const present = (await peers(at)).present;
	const receipt = receipts(at, present);
	const withdrawn = withdrawals(latest);
	const state = await questionStates(at, latest, ids, present, withdrawn);
	const shown = withinBudget(
		latest.map((message) =>
			[
				line(message),
				withdrawn.get(message.id) ?? "",
				receipt(message),
				state.get(message.id) ?? "",
			]
				.filter(Boolean)
				.join("\n  "),
		),
	);
	const left = latest.length - shown.length;
	const oldest = latest[left];
	const rest =
		left > 0 && oldest
			? `\n${capitalized(count(left, "older message"))} left out to keep this short; mesh_read with before ${shortId(oldest)} reads on.`
			: "";
	const text =
		latest.length > 0
			? `${shown.join("\n")}${rest}`
			: before === undefined
				? "Nothing on the mesh yet."
				: "Nothing this peer hears came before that.";
	return answer(`This peer is ${at.peer.addresses.join(" or ")}.\n${text}`);
}

/**
 * The newest of these rendered messages that fit
 * {@link READ_BUDGET_BYTES}, oldest first, and always the newest one.
 */
function withinBudget(rendered: readonly string[]): string[] {
	const kept: string[] = [];
	let spent = 0;
	for (const one of [...rendered].reverse()) {
		const bytes = Buffer.byteLength(one, "utf8") + 1;
		if (kept.length > 0 && spent + bytes > READ_BUDGET_BYTES) break;
		kept.unshift(one);
		spent += bytes;
	}
	return kept;
}

/**
 * Every question on the mesh still waiting on a peer it named, oldest
 * first, with how long it has waited and whether that peer is still
 * there (lib/mesh/unanswered.ts).
 */
async function openText(at: Local, now = Date.now()): Promise<string> {
	const since = now - UNANSWERED_WITHIN_MS;
	// Ids start with the time they were sent, so older ones go unread.
	const recent = (await at.transport.listAllIds()).filter(
		(id) => !(Number.parseInt(id, 10) < since),
	);
	const messages = (await readEachOff(at.transport, recent)).filter(
		(one): one is Message => one !== undefined,
	);
	const everyone = at.presences.all();
	const aliases = (address: string): readonly string[] =>
		everyone.find((one) => one.addresses.includes(address))?.addresses ?? [
			address,
		];
	const present = new Set(
		(await peers(at)).present.flatMap((one) => one.addresses),
	);
	const all = unanswered(messages, aliases, now);
	// An orchestrator sees its own orchestration's: the rest of the mesh
	// is not its to unstick. Any other session sees the whole mesh.
	const heads = at.peer.orchestrates;
	const members = heads
		? new Set([
				...at.peer.addresses,
				...everyone
					.filter((one) => one.orchestratedBy === heads)
					.flatMap((one) => one.addresses),
			])
		: undefined;
	const open = members ? withinOrchestration(all, members) : all;
	const where = members ? " in this orchestration" : "";
	const elsewhere =
		all.length > open.length
			? ` ${all.length - open.length} more elsewhere on the mesh are left out.`
			: "";
	if (open.length === 0) {
		return `No question ${members ? "in this orchestration" : "on the mesh"} is waiting on an answer.${elsewhere}`;
	}
	const lines = open.slice(-MOST_READ).map(({ message, waitingOn }) => {
		const minutes = Math.round((now - Date.parse(message.at)) / 60_000);
		const who = waitingOn
			.map((address) => {
				if (!present.has(address)) return `${address} (gone)`;
				const one = everyone.find((each) => each.addresses.includes(address));
				return `${address}${refusedMark(one && at.presences.refusal(one))}`;
			})
			.join(", ");
		const text = message.text.replace(/\s+/g, " ").trim();
		const cut =
			text.length > OPEN_CHARS ? `${text.slice(0, OPEN_CHARS - 3)}...` : text;
		return `${clock(message)} [${shortId(message)}] from ${message.from}, ${minutes} min, waiting on ${who}: ${cut}`;
	});
	const more =
		open.length > MOST_READ
			? ` (the newest ${MOST_READ} of ${open.length} shown)`
			: "";
	return `${open.length} ${open.length === 1 ? "question is" : "questions are"}${where} waiting on an answer, oldest first${more}:${elsewhere}\n${lines.join("\n")}`;
}

/** How much of an open question's text its line shows. */
const OPEN_CHARS = 100;

/**
 * Where each of this peer's own questions among these stands: answered,
 * and by whom; being answered, by a peer that took it up; or unanswered,
 * and for how long. A question nobody answers otherwise reads the same
 * as one answered in a group the asker never looked at. A pivot is
 * answered like a question, by each session once it has changed course,
 * and also names those it reached that have not, so one ignored shows.
 */
async function questionStates(
	at: Local,
	shown: readonly Message[],
	ids: readonly string[],
	present: readonly Presence[],
	withdrawn: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
	const self = { addresses: at.peer.addresses, ...senderIdentity() };
	const asked = shown.filter(
		(message) =>
			(message.intent === "question" || message.intent === "pivot") &&
			sentBy(message, self) &&
			!withdrawn.has(message.id),
	);
	const states = new Map<string, string>();
	const first = asked[0]?.id;
	if (first === undefined) return states;
	// Only what came after the oldest question can answer one.
	const answers = new Map<string, Message[]>();
	const later = await readEachOff(
		at.transport,
		ids.filter((id) => id > first),
	);
	for (const one of later) {
		if (one?.re === undefined || sentBy(one, self)) continue;
		answers.set(one.re, [...(answers.get(one.re) ?? []), one]);
	}
	const now = Date.now();
	const board = at.board.all();
	for (const question of asked) {
		const given = answers.get(question.id) ?? [];
		if (question.intent === "pivot") {
			states.set(question.id, pivotState(question, given, present, self));
			continue;
		}
		if (given.length > 0) {
			const by = [...new Set(given.map((one) => one.from))].join(", ");
			const last = given.at(-1) as Message;
			states.set(question.id, `answered by ${by}, last in [${shortId(last)}]`);
			continue;
		}
		const answering = othersOn(
			board,
			at.peer.session,
			"answer",
			question.id,
			now,
		)
			.map(
				(held) =>
					present.find((one) => one.session === held.session)?.addresses[0],
			)
			.filter((address): address is string => address !== undefined);
		states.set(
			question.id,
			answering.length > 0
				? `being answered by ${answering.join(", ")}`
				: `unanswered after ${since(question, now)}`,
		);
	}
	return states;
}

/**
 * Who of the sessions a pivot reached has answered it, having changed
 * course, and who has not yet.
 */
function pivotState(
	pivot: Message,
	given: readonly Message[],
	present: readonly Presence[],
	self: { addresses: readonly string[]; pid: number },
): string {
	const by = new Set(given.map((one) => one.from));
	const reached = present.filter(
		(one) =>
			!one.addresses.some((address) => self.addresses.includes(address)) &&
			(one.addresses.some((address) => pivot.to.includes(homeOf(address))) ||
				one.groups.some((group) => pivot.to.includes(group))),
	);
	const waiting = reached
		.filter((one) => !one.addresses.some((address) => by.has(address)))
		.map((one) => one.addresses[0] as string);
	const answered = by.size > 0 ? `changed course: ${[...by].join(", ")}` : "";
	const yet = waiting.length > 0 ? `not yet: ${waiting.join(", ")}` : "";
	return [answered, yet].filter(Boolean).join("; ") || "reached nobody present";
}

/**
 * The messages among these that a later one replaced, each with the
 * line that says so, so a withdrawn message is never read as standing.
 */
function withdrawals(messages: readonly Message[]): Map<string, string> {
	const byId = new Map(messages.map((one) => [one.id, one]));
	const withdrawn = new Map<string, string>();
	for (const one of messages) {
		const original = one.supersedes ? byId.get(one.supersedes) : undefined;
		if (original && mayReplace(one, original)) {
			withdrawn.set(
				original.id,
				`withdrawn: replaced by [${shortId(one)}], so go by that instead`,
			);
		}
	}
	return withdrawn;
}

/**
 * Who has a message this peer sent, and who it is still on its way to,
 * among the peers still there. A peer has it once its read marker has
 * passed it, which happens when the message is handed to its model,
 * at whatever attention; a peer mid-run gets it at its next step.
 */
function receipts(
	at: Local,
	present: readonly Presence[],
): (message: Message) => string {
	const marks = new Map<string, string | undefined>();
	const markOf = (one: Presence) => {
		if (!marks.has(one.session)) {
			marks.set(one.session, at.transport.lastRead(one.addresses));
		}
		return marks.get(one.session);
	};
	return (message) => {
		const own = sentBy(message, {
			addresses: at.peer.addresses,
			...senderIdentity(),
		});
		if (!own) return "";
		const meant = present.filter(
			(one) =>
				one.session !== at.peer.session &&
				one.addresses.length > 0 &&
				reaches(message, one, -1),
		);
		if (meant.length === 0) return "reached no peer";
		const signed = (list: readonly Presence[]) =>
			list.map((one) => one.addresses[0]).join(", ");
		const has = meant.filter((one) => (markOf(one) ?? "") >= message.id);
		const waiting = meant.filter((one) => !has.includes(one));
		return [
			has.length > 0
				? `${signed(has)} ${has.length === 1 ? "has" : "have"} it`
				: "",
			waiting.length > 0 ? `not yet ${signed(waiting)}` : "",
		]
			.filter(Boolean)
			.join("; ");
	};
}
