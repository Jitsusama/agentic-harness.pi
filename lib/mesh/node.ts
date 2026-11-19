/**
 * The machine's mycelium node, asked who is there and to start sessions
 * held.
 *
 * A session on another machine is written here by the node that carries
 * it (Jitsusama/mycelium), with its process taken out, since only its own
 * machine can judge that. The node can say what the file can't: it hears
 * the far machine's sessions start and end as they do, and knows the
 * moment the link to it drops. So a session elsewhere is judged by asking
 * the node over its socket, never by how lately its file was touched.
 *
 * The node serves one socket per realm, in the login's runtime folder, or
 * on a Mac in the account's own temporary folder, which a session's
 * `TMPDIR` need not name, since a quest moves that. The realm is the
 * session's own, as `MYCELIUM_REALM` names it, since a machine in two
 * realms runs a node for each; else the one the node last ran in, as it
 * keeps it.
 *
 * Long because it is the node's one client: every question asked of its
 * socket shares the same framing, patience and reading of the answer.
 */

import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMachineName } from "../internal/machine/machine.ts";
import { isRealmName } from "../internal/machine/realm.ts";
import { runtimeDir } from "../internal/paths.ts";
import { isRecord } from "../internal/record.ts";
import {
	type Need,
	needOnTheWire,
	type PlaceAnswer,
	placedFrom,
} from "./placement.ts";
import type { Said } from "./receptor.ts";

/** What a `message` kind's record key opens with, before the id. */
const MESSAGE_KEY = "message:";

/** What a node says of a session it holds. */
export type Held = "busy" | "idle" | "ended" | "unreachable";

/** The sessions a node holds, by session id, as it judges each. */
export type NodeSessions = ReadonlyMap<string, Held>;

/** Asks the machine's node, answering nothing when no node answers. */
export type AskNode = () => Promise<NodeSessions | undefined>;

/**
 * How long a node has to answer: it answers from what it holds, as
 * optimus's did in 74 ms under load, so a second is only ever spent on
 * one that hangs.
 */
export const NODE_PATIENCE_MS = 1000;

const HELD: readonly Held[] = ["busy", "idle", "ended", "unreachable"];

/** Every session the machine's node holds, or nothing when none answers. */
export const askNode: AskNode = () => sessionsAt(nodeSocket());

/**
 * Every session the node serving `socket` holds, or nothing when none
 * answers there within `patience`.
 */
export async function sessionsAt(
	socket: string | undefined,
	patience: number = NODE_PATIENCE_MS,
): Promise<NodeSessions | undefined> {
	const line = await askAt(socket, "Sessions", patience);
	return line === undefined ? undefined : sessionsFrom(line);
}

/**
 * How long a start has to answer: its holder says it holds the program
 * within 10 s, and a start on another machine is answered over its link
 * within 30 s, but a loaded node took over 45 s to reach either on 19
 * November, and the start still landed. A start not answered in this
 * may still land, so it is asked again under its name.
 */
export const START_PATIENCE_MS = 120_000;

/**
 * How long a placement has to answer: the node measures its own machine
 * afresh and the others from what their links last said, which takes
 * well under a second even on a loaded machine.
 */
export const PLACE_PATIENCE_MS = 5000;

/**
 * Asks the node serving `socket` where work needing `needs` goes, without
 * starting anything, answering the machine it chose or its reasons.
 */
export function placeAt(
	socket: string | undefined,
	needs: readonly Need[],
	patience: number = PLACE_PATIENCE_MS,
): Promise<PlaceAnswer> {
	return placeAsking("Place", socket, needs, patience);
}

/**
 * Asks the node serving `socket` where work needing `needs` goes, for a
 * spawn that starts it here itself when the node answers this machine,
 * and through the node's start anywhere else. The node counts an answer
 * of this machine as a start placed here, so a burst of spawns spreads
 * rather than each being told the machine the last one was. A node too
 * old to know that request is asked where, as before.
 */
export async function placeToStartAt(
	socket: string | undefined,
	needs: readonly Need[],
	patience: number = PLACE_PATIENCE_MS,
): Promise<PlaceAnswer> {
	const answer = await placeAsking("PlaceToStart", socket, needs, patience);
	return !answer.ok && answer.reason.startsWith(UNKNOWN_PLACE_TO_START)
		? placeAt(socket, needs, patience)
		: answer;
}

/** How a node too old to know an ask to start says it can't read one. */
const UNKNOWN_PLACE_TO_START = "not a request: unknown variant `PlaceToStart`";

async function placeAsking(
	request: "Place" | "PlaceToStart",
	socket: string | undefined,
	needs: readonly Need[],
	patience: number,
): Promise<PlaceAnswer> {
	if (socket === undefined) {
		return {
			ok: false,
			reason: "no mycelium realm is named here, so there is no node to ask",
		};
	}
	const asked = { [request]: { needs: needs.map(needOnTheWire) } };
	const line = await askAt(socket, asked, patience);
	if (line === undefined) {
		return { ok: false, reason: `no mycelium node answered at ${socket}` };
	}
	return placedFrom(line);
}

/** A program to start held on a machine, through the node. */
export interface NodeStart {
	/** The machine it must start on, as its node names it. */
	readonly machine: string;
	/**
	 * What else it needs of that machine, which the node checks again as
	 * it starts it, so a machine that changed since it was chosen refuses.
	 */
	readonly needs?: readonly Need[];
	/**
	 * The folder it begins in there: a full path, or one within that
	 * machine's home. Its node begins it in its home when this names none
	 * or no folder there.
	 */
	readonly folder?: string;
	/** The program and its words, run through the login shell there. */
	readonly command: readonly string[];
	/**
	 * The asker's name for this one start, at most 64 characters, given
	 * again when asking again after no answer came, so the node answers
	 * the start already landing rather than starting another. A node that
	 * knows no such name starts each ask.
	 */
	readonly once?: string;
}

/** A program the node started held, and how to join it. */
export interface NodeStarted {
	readonly machine: string;
	/** The id its holder keeps it by there. */
	readonly held: string;
	/** The folder it began in there. */
	readonly folder: string;
	/** The words that join it from a terminal here, to be run as given. */
	readonly attach: readonly string[];
}

/** What a start comes to: started, or why not, as the node says it. */
export type StartAnswer =
	| { readonly ok: true; readonly started: NodeStarted }
	| {
			readonly ok: false;
			readonly reason: string;
			/**
			 * The node took the ask and answered nothing in time, so the
			 * start may still land, and asking again under its name joins it.
			 */
			readonly mayLand?: true;
	  };

/**
 * Asks the node serving `socket` to start `start` held, answering where
 * and how to join it, or why it didn't.
 */
export async function startAt(
	socket: string | undefined,
	start: NodeStart,
	patience: number = START_PATIENCE_MS,
): Promise<StartAnswer> {
	if (socket === undefined) {
		return {
			ok: false,
			reason: "no mycelium realm is named here, so there is no node to ask",
		};
	}
	const asked = {
		Start: {
			work: {
				needs: [
					...(start.needs ?? [])
						.filter((need) => need.kind !== "machine")
						.map(needOnTheWire),
					{ machine: start.machine },
				],
			},
			...(start.folder !== undefined ? { folder: start.folder } : {}),
			command: start.command,
			...(start.once !== undefined ? { once: start.once } : {}),
		},
	};
	const heard = await hearAt(socket, asked, patience);
	if (heard.kind === "silent") {
		return {
			ok: false,
			reason: heard.hungUp
				? `the node at ${socket} took the ask and hung up before it answered`
				: `the node at ${socket} took the ask and answered nothing within ${patience / 1000} s`,
			mayLand: true,
		};
	}
	if (heard.kind === "unreached") {
		return { ok: false, reason: `no mycelium node answered at ${socket}` };
	}
	return startedFrom(heard.line);
}

/** A start's answer read: started, or the node's reason it didn't. */
export function startedFrom(line: string): StartAnswer {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Fall through to the answer this reader can't read.
	}
	if (isRecord(reply) && typeof reply.Err === "string") {
		return { ok: false, reason: reply.Err };
	}
	const started =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Started : undefined;
	if (
		isRecord(started) &&
		typeof started.machine === "string" &&
		typeof started.held === "string" &&
		Array.isArray(started.attach) &&
		started.attach.every((word) => typeof word === "string")
	) {
		return {
			ok: true,
			started: {
				machine: started.machine,
				held: started.held,
				folder: typeof started.folder === "string" ? started.folder : "",
				attach: started.attach,
			},
		};
	}
	return {
		ok: false,
		reason: `the node answered what this harness can't read: ${line.slice(0, 200)}`,
	};
}

/**
 * Asks the node serving `socket` one request, answering its one line, or
 * nothing when none answers there within `patience`.
 */
export async function askAt(
	socket: string | undefined,
	request: unknown,
	patience: number,
): Promise<string | undefined> {
	const heard = await hearAt(socket, request, patience);
	return heard.kind === "answered" ? heard.line : undefined;
}

/**
 * What asking a node comes to: its line, silence once it took the ask, or
 * no node reached.
 */
type Heard =
	| { readonly kind: "answered"; readonly line: string }
	| { readonly kind: "silent"; readonly hungUp: boolean }
	| { readonly kind: "unreached" };

/**
 * Asks the node serving `socket` one request, as {@link askAt} does,
 * telling a node that took the ask and said nothing within `patience`
 * from none there: what it was asked may still be done.
 */
function hearAt(
	socket: string | undefined,
	request: unknown,
	patience: number,
): Promise<Heard> {
	if (socket === undefined) return Promise.resolve({ kind: "unreached" });
	return new Promise((resolve) => {
		let said = "";
		let settled = false;
		let sent = false;
		const asking = connect(socket);
		const settle = (heard: Heard) => {
			if (settled) return;
			settled = true;
			clearTimeout(waiting);
			asking.destroy();
			resolve(heard);
		};
		const unanswered = (hungUp: boolean): Heard =>
			sent ? { kind: "silent", hungUp } : { kind: "unreached" };
		const waiting = setTimeout(() => settle(unanswered(false)), patience);
		asking.setEncoding("utf8");
		asking.on("connect", () => {
			asking.write(`${JSON.stringify(request)}\n`);
			sent = true;
		});
		asking.on("data", (chunk: string) => {
			said += chunk;
			const end = said.indexOf("\n");
			if (end >= 0) settle({ kind: "answered", line: said.slice(0, end) });
		});
		// No node there, or one that went away before it answered: one that
		// hung up after taking the ask may still have done it.
		asking.on("error", () => settle(unanswered(true)));
		asking.on("close", () => settle(unanswered(true)));
	});
}

/** The window a node says a held session is shown in. */
export interface NodeWindow {
	readonly terminal: string;
	readonly id: string;
	readonly within?: string;
}

/**
 * The window the node serving `socket` says the session it holds as
 * `held` is shown in, or nothing when none answers or none is joined.
 */
export async function heldWindowAt(
	socket: string | undefined,
	held: string,
	patience: number = NODE_PATIENCE_MS,
): Promise<NodeWindow | undefined> {
	const line = await askAt(socket, "Sessions", patience);
	return line === undefined ? undefined : heldWindowFrom(line, held);
}

/** The window a node's answer gives the session held as `held`. */
export function heldWindowFrom(
	line: string,
	held: string,
): NodeWindow | undefined {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Not an answer this reader knows, so no window is named.
		return undefined;
	}
	const sessions =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Sessions : undefined;
	if (!Array.isArray(sessions)) return undefined;
	const one: unknown = sessions.find(
		(each) => isRecord(each) && each.held === held,
	);
	const window = isRecord(one) ? one.window : undefined;
	if (
		!isRecord(window) ||
		typeof window.terminal !== "string" ||
		typeof window.id !== "string"
	) {
		return undefined;
	}
	return {
		terminal: window.terminal,
		id: window.id,
		...(typeof window.within === "string" ? { within: window.within } : {}),
	};
}

/** The sessions a node's answer names, or nothing when it names none. */
export function sessionsFrom(line: string): NodeSessions | undefined {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Not an answer this reader knows, so the node is taken as not
		// answering rather than as holding nobody.
		return undefined;
	}
	const sessions =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Sessions : undefined;
	if (!Array.isArray(sessions)) return undefined;
	const held = new Map<string, Held>();
	for (const one of sessions) {
		if (!isRecord(one) || typeof one.id !== "string") continue;
		const state = HELD.find((each) => each === one.state);
		if (state) held.set(one.id, state);
	}
	return held;
}

/**
 * One session a node holds, with the machine it is on and its state,
 * both as the node said them, so a reader that judges by them can treat
 * a state it doesn't know, or a missing machine, as it must.
 */
export interface NodeSession {
	readonly id: string;
	/** The address its messages sign, where the node says it. */
	readonly address?: string;
	/** The machine it is on, where the node says it. */
	readonly machine?: string;
	/** Its state as the node named it, as `idle`, or `unknown` for none. */
	readonly state: string;
}

/**
 * Every session the node serving `socket` holds, with the machine each
 * is on, or nothing when none answers there within `patience`.
 */
export async function nodeSessionsAt(
	socket: string | undefined,
	patience: number = NODE_PATIENCE_MS,
): Promise<NodeSession[] | undefined> {
	const line = await askAt(socket, "Sessions", patience);
	return line === undefined ? undefined : nodeSessionsFrom(line);
}

/**
 * The sessions a node's answer names, each with its machine, or nothing
 * when it names none. Only a session without an id is passed over; one
 * without a machine or a state is kept without them.
 */
export function nodeSessionsFrom(line: string): NodeSession[] | undefined {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Not an answer this reader knows, so the node is taken as not
		// answering rather than as holding nobody.
		return undefined;
	}
	const sessions =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Sessions : undefined;
	if (!Array.isArray(sessions)) return undefined;
	return sessions.flatMap((one: unknown): NodeSession[] => {
		if (!isRecord(one)) return [];
		const { id, address, machine, state } = one;
		return [
			{
				// A row with no id is still a session there, never nobody.
				id: typeof id === "string" ? id : "",
				...(typeof address === "string" ? { address } : {}),
				...(typeof machine === "string" ? { machine } : {}),
				state: typeof state === "string" ? state : "unknown",
			},
		];
	});
}

/**
 * The command each machine starts an agent session with in this realm,
 * as its node declares it (`declared.agents`), by machine: pi-claude in
 * the realm Joel's own Claude plan works in, pi elsewhere. A machine
 * that declares none is left out, so its caller keeps plain pi. Nothing
 * when no node answers.
 */
export async function agentsAt(
	socket: string | undefined,
	patience: number = PLACE_PATIENCE_MS,
): Promise<ReadonlyMap<string, string> | undefined> {
	const line = await askAt(socket, "Machines", patience);
	return line === undefined ? undefined : agentsFrom(line);
}

/**
 * The agent command each machine in a node's answer declares. A node
 * tells only its own realm's entry, so a machine's is the one it names;
 * one naming several, which no node sends, is left out rather than
 * guessed at.
 */
export function agentsFrom(line: string): ReadonlyMap<string, string> {
	const agents = new Map<string, string>();
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Not an answer this reader knows: no machine declares anything.
		return agents;
	}
	const machines =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Machines : undefined;
	if (!Array.isArray(machines)) return agents;
	for (const machine of machines) {
		if (!isRecord(machine) || typeof machine.name !== "string") continue;
		const declared = isRecord(machine.declared)
			? machine.declared.agents
			: undefined;
		if (!isRecord(declared)) continue;
		const commands = Object.values(declared);
		const [command] = commands;
		if (commands.length === 1 && typeof command === "string" && command) {
			agents.set(machine.name, command);
		}
	}
	return agents;
}

/** A tie the node keeps between a cell and another, faded to now. */
export interface Tie {
	/** The other end, as the node names it: the address its messages sign. */
	readonly other: string;
	/** How strong it is now: one a message, halving every two hours. */
	readonly strength: number;
	/** This cell's messages on it and the other's, in the last hour. */
	readonly hour: readonly [number, number];
	/** This cell's messages on it and the other's, in the last day. */
	readonly today: readonly [number, number];
	/** The intents its messages had, sorted. */
	readonly intents: readonly string[];
}

/** How long a tie's strength takes to halve, as the node fades it. */
export const TIE_HALF_LIFE_MS = 2 * 60 * 60 * 1000;

/**
 * How long the node has to list its ties: every tie of the realm comes
 * back, 50,000 at the node's ceiling, so more than a sessions answer.
 */
export const TIES_PATIENCE_MS = 2000;

/**
 * The fields a tie is read by, so its groups and the rest stay off the
 * wire. The node adds only `key` and `kind`: asked without `heard`, it
 * answered 1268 ties on 17 November and every one was dropped unfaded.
 */
const TIE_FIELDS = ["hour", "today", "intents", "strength", "heard"];

/**
 * The ties of the cell going by any of `cells`, strongest first, from
 * the node serving `socket` (Jitsusama/mycelium's `tie` kind); nothing
 * when no node answers or it keeps no ties, as before mycelium #245.
 * Asked once a call, never watched, since a reader wants them now.
 */
export async function tiesAt(
	socket: string | undefined,
	cells: readonly string[],
	now: number = Date.now(),
	patience: number = TIES_PATIENCE_MS,
): Promise<Tie[] | undefined> {
	const line = await askDaemon(
		socket,
		{ ask: "list", kind: "tie", fields: TIE_FIELDS },
		patience,
	);
	return line === undefined ? undefined : tiesFrom(line, cells, now);
}

/**
 * The ties in a node's list of its `tie` kind that hold one of `cells`
 * at an end, each faded to `now` by 2^-((now - heard) / 2 h) and
 * strongest first; nothing for an answer that lists no records, such
 * as a node refusing a kind it doesn't know.
 */
export function tiesFrom(
	line: string,
	cells: readonly string[],
	now: number,
): Tie[] | undefined {
	let answer: unknown;
	try {
		answer = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(answer) || !Array.isArray(answer.records)) return undefined;
	const mine = new Set(cells.map((cell) => cell.toUpperCase()));
	const ties = answer.records.flatMap((record: unknown): Tie[] => {
		if (!isRecord(record) || typeof record.key !== "string") return [];
		// A cell's own talk, `tie:<A>`, names no other end.
		const ends = record.key.replace(/^tie:/, "").split("~");
		const [first, second] = ends;
		if (ends.length !== 2 || first === undefined || second === undefined) {
			return [];
		}
		const at = mine.has(first) ? 0 : mine.has(second) ? 1 : undefined;
		const hour = pair(record.hour);
		const today = pair(record.today);
		const { strength, heard } = record;
		if (at === undefined || !hour || !today) return [];
		if (typeof strength !== "number" || typeof heard !== "number") return [];
		const ours = (counts: [number, number]): [number, number] =>
			at === 0 ? counts : [counts[1], counts[0]];
		return [
			{
				other: at === 0 ? second : first,
				strength: strength * 2 ** (-(now - heard) / TIE_HALF_LIFE_MS),
				hour: ours(hour),
				today: ours(today),
				intents: Array.isArray(record.intents)
					? record.intents.filter((one) => typeof one === "string")
					: [],
			},
		];
	});
	return ties.sort((a, b) => b.strength - a.strength);
}

/**
 * The node's list of one kind of record, with only `fields` beside the
 * key and kind it always adds, as its one answer line; nothing
 * when no node answers within `patience`. A node that holds no such kind
 * answers with an error, which its reader takes as none.
 */
export function listAt(
	socket: string | undefined,
	kind: string,
	fields: readonly string[],
	patience: number,
): Promise<string | undefined> {
	return askDaemon(socket, { ask: "list", kind, fields }, patience);
}

/**
 * What the node serving `socket` serves of the messages `ids`, by id, as
 * its `message` kind's records: what it took, which for a receptor's
 * name is only what it said itself (Jitsusama/mycelium #267). Nothing
 * when no node answers, so a caller vouching for a message vouches for
 * none.
 */
export async function servedAt(
	socket: string | undefined,
	ids: readonly string[],
	patience: number = NODE_PATIENCE_MS,
): Promise<ReadonlyMap<string, Said> | undefined> {
	if (ids.length === 0) return new Map();
	const line = await askDaemon(
		socket,
		{ ask: "get", keys: ids.map((id) => `${MESSAGE_KEY}${id}`) },
		patience,
	);
	return line === undefined ? undefined : servedFrom(line);
}

/**
 * The messages a node's `get` answer holds, by id, each with its sender,
 * text and time, and what it asks or answers where its record says, or
 * nothing for an answer that lists no records, such as a refusal. A
 * record missing any of the first three is left out, as no message. A
 * `get` answers records whole (PROTOCOL.md, The Daemon Interface), so
 * nothing need be asked for by name.
 */
export function servedFrom(
	line: string,
): ReadonlyMap<string, Said> | undefined {
	let answer: unknown;
	try {
		answer = JSON.parse(line);
	} catch {
		// Not an answer this reader knows, so nothing is served.
		return undefined;
	}
	if (!isRecord(answer) || !Array.isArray(answer.records)) return undefined;
	return new Map(
		answer.records.flatMap((record: unknown): [string, Said][] => {
			if (
				!isRecord(record) ||
				typeof record.key !== "string" ||
				!record.key.startsWith(MESSAGE_KEY)
			) {
				return [];
			}
			const said = saidIn(record);
			return said ? [[record.key.slice(MESSAGE_KEY.length), said]] : [];
		}),
	);
}

/**
 * A served message record as what the node holds of it, or nothing for
 * one without a sender, text and time.
 */
function saidIn(record: Record<string, unknown>): Said | undefined {
	const text = (field: string): string | undefined => {
		const value = record[field];
		return typeof value === "string" ? value : undefined;
	};
	const from = text("from");
	const said = text("text");
	const at = text("at");
	if (from === undefined || said === undefined || at === undefined) {
		return undefined;
	}
	const groups = record.groups;
	return {
		from,
		text: said,
		at,
		...(Array.isArray(groups) &&
		groups.every((group) => typeof group === "string")
			? { groups }
			: {}),
		...(text("intent") !== undefined ? { intent: text("intent") } : {}),
		...(text("re") !== undefined ? { re: text("re") } : {}),
		...(text("supersedes") !== undefined
			? { supersedes: text("supersedes") }
			: {}),
		...(record.endsHold === true ? { endsHold: true } : {}),
		...(text("fromRealm") !== undefined
			? { fromRealm: text("fromRealm") }
			: {}),
	};
}

/** Two counts, as a tie says each end's, or nothing for anything else. */
function pair(said: unknown): [number, number] | undefined {
	if (!Array.isArray(said) || said.length !== 2) return undefined;
	const [a, b] = said;
	return typeof a === "number" && typeof b === "number" ? [a, b] : undefined;
}

/**
 * Asks the node serving `socket` one request in its daemon interface,
 * which a client opens with `hello` before any other ask, answering the
 * request's one line, or nothing when none answers within `patience`.
 */
function askDaemon(
	socket: string | undefined,
	request: Record<string, unknown>,
	patience: number,
): Promise<string | undefined> {
	if (socket === undefined) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let said = "";
		let settled = false;
		const asking = connect(socket);
		const settle = (answer: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(waiting);
			asking.destroy();
			resolve(answer);
		};
		const waiting = setTimeout(() => settle(undefined), patience);
		asking.setEncoding("utf8");
		asking.on("connect", () =>
			asking.write(`${JSON.stringify({ id: 1, ask: "hello" })}\n`),
		);
		asking.on("data", (chunk: string) => {
			said += chunk;
			for (let end = said.indexOf("\n"); end >= 0; end = said.indexOf("\n")) {
				const line = said.slice(0, end);
				said = said.slice(end + 1);
				const id = answerId(line);
				if (id === 1) {
					asking.write(`${JSON.stringify({ id: 2, ...request })}\n`);
				} else if (id === 2) {
					settle(line);
				} else {
					// A node that speaks no daemon interface answers no id.
					settle(undefined);
				}
			}
		});
		// No node there, or one that went away: either way none answers.
		asking.on("error", () => settle(undefined));
		asking.on("close", () => settle(undefined));
	});
}

/** The id an answer in the daemon interface carries, or nothing. */
function answerId(line: string): unknown {
	try {
		const answer: unknown = JSON.parse(line);
		return isRecord(answer) ? answer.id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every machine the node's realm holds, by name, whether or not any
 * session is on it; nothing when no node answers.
 */
export async function machineNamesAt(
	socket: string | undefined,
	patience: number = NODE_PATIENCE_MS,
): Promise<string[] | undefined> {
	const line = await askAt(socket, "Machines", patience);
	return line === undefined ? undefined : machineNamesFrom(line);
}

/**
 * The machines a node's `Machines` answer names, or nothing for an
 * answer naming none, so a refusal is no answer rather than no machine.
 * A name no machine could have is left out, since an empty one would
 * match any word a machine's name is looked for in.
 */
export function machineNamesFrom(line: string): string[] | undefined {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Not an answer this reader knows: it names no machine.
		return undefined;
	}
	const machines =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Machines : undefined;
	if (!Array.isArray(machines)) return undefined;
	return machines.flatMap((machine: unknown) =>
		isRecord(machine) && isMachineName(machine.name) ? [machine.name] : [],
	);
}

/** The socket the machine's node serves, or nothing when no realm is named. */
export function nodeSocket(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const realm = realmOf(env);
	if (!realm) return undefined;
	const base = runtimeDir(env);
	return base ? join(base, "mycelium", `${realm}.sock`) : undefined;
}

/**
 * The socket of every realm's node on this machine: the session's own
 * realm's first, though its node hasn't started, then each other realm
 * a socket is served for. A machine in two realms runs a node for each,
 * and a reboot ends the sessions of both. None when no realm is named.
 */
export function nodeSockets(env: NodeJS.ProcessEnv = process.env): string[] {
	const own = nodeSocket(env);
	if (own === undefined) return [];
	const base = runtimeDir(env);
	let others: string[] = [];
	try {
		if (base) {
			const folder = join(base, "mycelium");
			others = readdirSync(folder)
				.filter((name) => name.endsWith(".sock"))
				.sort()
				.map((name) => join(folder, name));
		}
	} catch {
		// No node has served a socket here yet: only the own realm's is known.
	}
	return [own, ...others.filter((socket) => socket !== own)];
}

/** What a socket nothing serves answers a connection with. */
const NOTHING_SERVES = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]);

/**
 * Whether a node serves `socket`: false only when the socket refuses
 * the connection, as one a node left behind when it ended does; true
 * when one connects, or when the socket can't say, so a node that is
 * there but slow still counts as one.
 */
export function nodeServes(
	socket: string,
	patience: number = NODE_PATIENCE_MS,
): Promise<boolean> {
	return new Promise((resolve) => {
		const trying = connect(socket);
		const settle = (serves: boolean) => {
			clearTimeout(waiting);
			trying.destroy();
			resolve(serves);
		};
		const waiting = setTimeout(() => settle(true), patience);
		trying.on("connect", () => settle(true));
		trying.on("error", (error: NodeJS.ErrnoException) =>
			settle(!NOTHING_SERVES.has(error.code ?? "")),
		);
	});
}

/**
 * The realm the machine's node is asked in, or nothing when none is
 * named, or the one named is no name a socket's file may carry.
 */
export function realmOf(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	// The session's own first: the node's kept realm is the machine's
	// first, and a session in its second realm would ask the wrong node.
	// A session naming one no folder carries joins no mesh, so asks none.
	const own = env.MYCELIUM_REALM?.trim();
	if (own) return isRealmName(own) ? own : undefined;
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	try {
		const kept = readFileSync(join(state, "mycelium", "realm"), "utf8").trim();
		if (kept) return isRealmName(kept) ? kept : undefined;
	} catch {
		// No node has run here yet, and the login names no realm.
	}
	return undefined;
}
