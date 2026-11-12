/**
 * /host: the person moves the session in front of them into the realm's
 * shared host, in place, rather than steering it from outside.
 *
 * It is the move a steer's `move` act makes (moving.ts), handing the
 * window to the join (in-place.ts), so the window stays where it is and
 * the host's viewer takes over the same terminal; a run under way, a
 * job out or a prompt open holds it first, as it holds any move. A
 * move from inside has nothing outside to adopt its log once its pi
 * ends, so /host starts a take-up for this one session first
 * (scripts/host-take-up.ts), which adopts the log into the host once
 * the pi has gone and ends if the move is called off.
 *
 * Where a move can't land it refuses, saying why, and changes nothing:
 * a conversation hosted already, a window its holder doesn't run itself
 * (the move would close it rather than keep it), a session with no log
 * yet, a realm that starts another agent than pi (Joel's personal one
 * starts pi-claude, which no host runs), and a host not listening.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type HostKind,
	hostKey,
	hostRealm,
	hostSocketPath,
} from "../../host/service/address.ts";
import { controlRequest } from "../../host/service/client.ts";
import {
	AGAIN_ENV,
	flagsLost,
	heldDirectly,
	WAKE_ENV,
} from "../../lib/internal/session/park.ts";
import type { Moving } from "../../lib/mesh/moving.ts";
import type { HandOver } from "./in-place.ts";

/** The script that takes a /host move up once its pi has gone. */
export const TAKE_UP_SCRIPT = fileURLToPath(
	new URL("../../scripts/host-take-up.ts", import.meta.url),
);

/** What a host refuses to connect with before any request is written. */
const NOT_LISTENING = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

/** How /host is used, said when it is asked for a host it doesn't know. */
export const HOST_USAGE =
	"Usage: /host [attended|background]: move this session into that host, the background one unless said, keeping this window.";

/** What /host needs from its session. */
export interface HostCommandFacts {
	/** The session's id, once it is on the mesh. */
	readonly session: () => string | undefined;
	/** The host it runs in, by key, when it runs in one. */
	readonly hostedIn: () => string | undefined;
	/** The move it waits to make, as its peer keeps it. */
	readonly moving: () => Moving | undefined;
	/** Its saved log. */
	readonly sessionFile: () => string | undefined;
	/** How it would hand its window to the join (in-place.ts). */
	readonly handOver: () => HandOver | undefined;
	/** Its environment, which names its realm and its holder. */
	readonly env: NodeJS.ProcessEnv;
	/** Its process's id, which its holder's record names. */
	readonly pid: number;
	/** The arguments it was started with. */
	readonly args: readonly string[];
	/** This machine's name, as the realm's node knows it. */
	readonly machine: string;
	/** The agent command each machine of the realm declares, or nothing. */
	readonly agents: () => Promise<ReadonlyMap<string, string> | undefined>;
	/** Ask a host for its list; throws when it can't be reached. */
	readonly probe: (socket: string) => Promise<void>;
	/** Start the move in place, as asked in its window (moving.ts). */
	readonly move: (to: HostKind) => void;
	/** Start the take-up that adopts its log into `to` once its pi has gone. */
	readonly takeUp: (session: string, to: HostKind) => void;
}

/** The host `/host <args>` asks for, or nothing when it names none known. */
function kindOf(args: string): HostKind | undefined {
	const asked = args.trim();
	if (asked === "" || asked === "background") return "background";
	return asked === "attended" ? "attended" : undefined;
}

function messageOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\.$/, "");
}

function notListening(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return typeof error.code === "string" && NOT_LISTENING.has(error.code);
}

/** Why its holder can't take the window into the join. */
function whyNotHeld(facts: HostCommandFacts): string {
	const wake = facts.env[WAKE_ENV];
	if (!(wake && facts.env[AGAIN_ENV]))
		return "nothing holds it: it wasn't started by mycelium's hold";
	if (!heldDirectly(wake, facts.pid))
		return "its holder runs a shell, not this pi, so its end would leave a prompt";
	const lost = flagsLost(facts.args);
	if (lost.length > 0)
		return `a restart would lose the flags it was started with (${lost.join(", ")})`;
	return "its holder can't be handed a next command";
}

/**
 * Move this session into the host `/host <args>` names, in its window:
 * nothing when the move began (moving.ts says so on screen), or why it
 * can't, with nothing changed.
 */
export async function moveIntoHost(
	args: string,
	facts: HostCommandFacts,
): Promise<string | undefined> {
	const to = kindOf(args);
	if (to === undefined) return HOST_USAGE;
	const session = facts.session();
	if (session === undefined)
		return "This session isn't on the mesh yet, so there's nothing to move.";
	const hosted = facts.hostedIn();
	if (hosted !== undefined)
		return `This session runs in the ${hosted} host already; /host moves a plain pi into one.`;
	const waiting = facts.moving();
	if (waiting !== undefined)
		return `This session is already moving to ${waiting.to === "pi" ? "plain pi" : `the ${waiting.to} host`}; it goes once nothing of its own is out.`;
	if (facts.sessionFile() === undefined)
		return "This session has no saved file yet for a host to take up; it stays here.";
	if (facts.handOver() === undefined)
		return `This window can't pass to the host, so moving would close it, and this session stays here: ${whyNotHeld(facts)}.`;
	let key: string;
	let socket: string;
	try {
		const realm = hostRealm(facts.env);
		key = hostKey(realm, to);
		socket = hostSocketPath(realm, to, facts.env.XDG_RUNTIME_DIR);
	} catch (error) {
		return `There's no host here (${messageOf(error)}), so this session stays here.`;
	}
	const agent = (await facts.agents())?.get(facts.machine);
	if (agent !== undefined && agent !== "pi")
		return `This realm starts ${agent} for its sessions, which no host runs, so this session stays here.`;
	try {
		await facts.probe(socket);
	} catch (error) {
		if (notListening(error))
			return `No ${key} host is listening at ${socket}, so this session stays here.`;
		// Anything else, such as a host too busy to list in time, is a host
		// that is there, and its adopt decides.
	}
	facts.move(to);
	// A move that stopped at once said why on screen, and leaves nothing
	// to take up.
	if (facts.moving() !== undefined) facts.takeUp(session, to);
	return undefined;
}

/** Ask the host at `socket` for its list; throws when it can't be reached. */
export async function probeHost(socket: string): Promise<void> {
	await controlRequest(socket, { v: 1, id: randomUUID(), op: "list" });
}

/**
 * Start the take-up for `session`'s move into `to`, on its own, so it
 * outlives this pi: what it says goes to a log beside the presences.
 */
export function startTakeUp(
	session: string,
	to: HostKind,
	stateFolder: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const logs = join(stateFolder, "take-up");
	mkdirSync(logs, { recursive: true });
	const log = openSync(join(logs, `${session}.log`), "a");
	const child = spawn(
		process.execPath,
		["--no-warnings", TAKE_UP_SCRIPT, "--session", session, "--to", to],
		{ detached: true, stdio: ["ignore", log, log], env },
	);
	child.unref();
	// The child holds its own copy of the log; this pi needs none.
	closeSync(log);
}
