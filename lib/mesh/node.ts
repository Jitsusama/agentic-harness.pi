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
 * `TMPDIR` need not name, since a quest moves that. The realm is the one
 * the node last ran in, as it keeps it, else the one the login names.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { isRecord } from "../internal/record.ts";

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

/** A program to start held on a machine, through the node. */
export interface NodeStart {
	/** The machine it must start on, as its node names it. */
	readonly machine: string;
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
			work: { needs: [{ machine: start.machine }] },
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

/** The socket the machine's node serves, or nothing when no realm is named. */
export function nodeSocket(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const realm = realmOf(env);
	if (!realm) return undefined;
	const base = env.XDG_RUNTIME_DIR || accountTemporary();
	return base ? join(base, "mycelium", `${realm}.sock`) : undefined;
}

function realmOf(env: NodeJS.ProcessEnv): string | undefined {
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	try {
		const kept = readFileSync(join(state, "mycelium", "realm"), "utf8").trim();
		if (kept) return kept;
	} catch {
		// No node has run here yet: the login's realm, if it names one.
	}
	return env.MYCELIUM_REALM || undefined;
}

let darwinTemporary: string | undefined;

/** A Mac account's own temporary folder, where its node's socket goes. */
function accountTemporary(): string | undefined {
	if (platform() !== "darwin") return undefined;
	if (darwinTemporary === undefined) {
		try {
			darwinTemporary = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
				encoding: "utf8",
			}).trim();
		} catch {
			// The system won't say, so no node's socket can be found.
			darwinTemporary = "";
		}
	}
	return darwinTemporary || undefined;
}
