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
 */

import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { runtimeDir } from "../internal/paths.ts";
import { isRecord } from "../internal/record.ts";
import {
	type Need,
	needOnTheWire,
	type PlaceAnswer,
	placedFrom,
} from "./placement.ts";

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
 * within 30 s, so this outlasts both with a few seconds to spare.
 */
export const START_PATIENCE_MS = 45_000;

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
export async function placeAt(
	socket: string | undefined,
	needs: readonly Need[],
	patience: number = PLACE_PATIENCE_MS,
): Promise<PlaceAnswer> {
	if (socket === undefined) {
		return {
			ok: false,
			reason: "no mycelium realm is named here, so there is no node to ask",
		};
	}
	const asked = { Place: { needs: needs.map(needOnTheWire) } };
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
	| { readonly ok: false; readonly reason: string };

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
		},
	};
	const line = await askAt(socket, asked, patience);
	if (line === undefined) {
		return { ok: false, reason: `no mycelium node answered at ${socket}` };
	}
	return startedFrom(line);
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
function askAt(
	socket: string | undefined,
	request: unknown,
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
		asking.on("connect", () => asking.write(`${JSON.stringify(request)}\n`));
		asking.on("data", (chunk: string) => {
			said += chunk;
			const end = said.indexOf("\n");
			if (end >= 0) settle(said.slice(0, end));
		});
		// No node there, or one that went away: either way none answers.
		asking.on("error", () => settle(undefined));
		asking.on("close", () => settle(undefined));
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

/** The socket the machine's node serves, or nothing when no realm is named. */
export function nodeSocket(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const realm = realmOf(env);
	if (!realm) return undefined;
	const base = runtimeDir(env);
	return base ? join(base, "mycelium", `${realm}.sock`) : undefined;
}

function realmOf(env: NodeJS.ProcessEnv): string | undefined {
	// The session's own first: the node's kept realm is the machine's
	// first, and a session in its second realm would ask the wrong node.
	if (env.MYCELIUM_REALM) return env.MYCELIUM_REALM;
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	try {
		const kept = readFileSync(join(state, "mycelium", "realm"), "utf8").trim();
		if (kept) return kept;
	} catch {
		// No node has run here yet, and the login names no realm.
	}
	return undefined;
}
