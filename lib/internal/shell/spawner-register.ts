/**
 * A pi host tells the machine's mycelium node which of its sessions each
 * pi-spawner it starts serves, so the node can tell which session asked
 * it for a run though a host's sessions share its process (mycelium's
 * PROTOCOL.md, A Hosted Session's Spawner).
 *
 * The host says it on its own connection, so the node knows the speaker
 * from the kernel, not from anything it says: the node takes the word
 * only from a process that proves the session as its host, and only of
 * its own child named pi-spawner, started at the clock tick the host
 * read for it. Nothing an agent's command can say reaches that
 * connection, which the node's socket opens close-on-exec, so a command
 * the host starts holds none of it. The tick is read once, as the
 * spawner starts (spawner.ts), and said each time, so a spawner that
 * ended and left its id to another is never named: the node refuses a
 * pid whose start differs. The word waits for the spawner's own name,
 * since one started in a scope goes by systemd-run's until that hands
 * over to it, and a spawner that never gets its name is never named.
 *
 * It stops a command claiming another session's spawner; it doesn't stop
 * code running inside the host itself, as an extension a project brings
 * or a reload onto another tree, which can say what it likes, nor a
 * command that rewrites the harness's files and restarts the host, whose
 * next start runs that code, or writes pi's host records and starts a
 * Node.js of its own that passes the node's checks; only a fence round
 * every conversation's commands does. A refusal is said once for each
 * reason on the host's error output, as the node logs it. The
 * node keeps the word only while it runs, so spawner.ts says it again
 * every 30 seconds while the spawner runs. Where the
 * node isn't there, or doesn't know the word, nothing is said and the
 * spawner's commands are told no session, as before. With no /proc, as
 * on a Mac, there is no tick to read, and nothing is said. A command a
 * host's restart keeps runs on under a spawner the next host didn't
 * start, and so is told no session from then on.
 */

import { readFile } from "node:fs/promises";
import { askAt, nodeSocket } from "../../mesh/node.ts";

/** How long the host waits on the node's answer, at most. */
export const REGISTER_PATIENCE_MS = 2000;

/**
 * How long the host waits for the spawner to go by its own name, at most:
 * a scoped start's systemd-run asks the user's manager first, which a
 * busy machine slows, and the node's answer gets its own time after.
 */
export const NAME_PATIENCE_MS = 2000;

/** How often the spawner's name is read while it isn't yet its own. */
const NAME_POLL_MS = 5;

/**
 * The name a pi-spawner goes by in /proc, once it runs: spawner.ts's
 * program name, said again here since that module imports this one.
 */
const SPAWNER_NAME = "pi-spawner";

/** The field of /proc's stat holding a process's start, counted from one. */
const START_FIELD = 22;

/** A pi-spawner as the node is told of it: its pid and when it started. */
export interface Spawned {
	pid: number;
	/** Clock ticks since boot, as /proc's stat says it (startOf). */
	started: number;
}

/** Where registration looks and asks; each defaults to the real thing. */
export interface RegisterOptions {
	/** The node's socket, or nothing where no realm is named. */
	socket?: string | undefined;
	/** Where the kernel's processes are read. */
	proc?: string;
	/** How long to wait on the node's answer. */
	patience?: number;
	/** How long to wait for the spawner to go by its own name. */
	namePatience?: number;
	/** Where a refusal is said; the host's error output by default. */
	say?: (line: string) => void;
}

/**
 * Tell the node that `spawned`, a pi-spawner this process started,
 * serves `session`. It settles once the node answers, or patience runs
 * out, whatever is said; a refusal is the node's to log.
 */
export async function registerSpawner(
	spawned: Spawned,
	session: string,
	options: RegisterOptions = {},
): Promise<void> {
	const { pid, started } = spawned;
	const proc = options.proc ?? "/proc";
	const patience = options.patience ?? REGISTER_PATIENCE_MS;
	const namePatience = options.namePatience ?? NAME_PATIENCE_MS;
	const socket = "socket" in options ? options.socket : nodeSocket();
	if (socket === undefined) return;
	if (!(await namedSpawner(pid, proc, Date.now() + namePatience))) return;
	const answer = await askAt(
		socket,
		{ Spawned: { pid, started, session } },
		patience,
	);
	const why = refusalIn(answer);
	if (why === undefined || saidRefusals.has(why)) return;
	if (saidRefusals.size >= REFUSALS_SAID) return;
	saidRefusals.add(why);
	(options.say ?? ((line) => process.stderr.write(line)))(
		`pi-spawner's session isn't named to the mycelium node, so its commands are told no conversation: ${why}\n`,
	);
}

/**
 * The reasons a node refused the word, each said once on the host's
 * error output, as the node says each once in its own log. A refusal of
 * the host itself, as for its inspector, names no session, so a host's
 * conversations share it; one naming a spawner or a session is said
 * once each, up to REFUSALS_SAID.
 */
const saidRefusals = new Set<string>();

/**
 * How many reasons a host says at most, so one running for weeks never
 * grows with spawners refused one by one.
 */
const REFUSALS_SAID = 32;

/** The node's reason, when its answer refuses the word. */
function refusalIn(answer: string | undefined): string | undefined {
	if (answer === undefined) return undefined;
	try {
		const reply: unknown = JSON.parse(answer);
		if (
			typeof reply === "object" &&
			reply !== null &&
			"Err" in reply &&
			typeof reply.Err === "string"
		) {
			return reply.Err;
		}
	} catch {
		// An answer this harness can't read refuses nothing it can say.
	}
	return undefined;
}

/** When `pid` started, in clock ticks since boot, or nothing once it's gone. */
export async function startOf(
	pid: number,
	proc = "/proc",
): Promise<number | undefined> {
	try {
		const stat = await readFile(`${proc}/${pid}/stat`, "utf8");
		// The name, in brackets, may hold spaces; the fields after it don't.
		const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		// The state is the third field, and the first after the name.
		const start = Number(after[START_FIELD - 3]);
		return Number.isSafeInteger(start) ? start : undefined;
	} catch {
		// No /proc here, or the spawner has already ended.
		return undefined;
	}
}

/** Whether `pid` goes by pi-spawner's name before `until`. */
async function namedSpawner(
	pid: number,
	proc: string,
	until: number,
): Promise<boolean> {
	for (;;) {
		const name = await nameOf(pid, proc);
		if (name === SPAWNER_NAME) return true;
		if (name === undefined || Date.now() >= until) return false;
		await new Promise((settle) => setTimeout(settle, NAME_POLL_MS));
	}
}

/** The process's name, as /proc's comm says it, or nothing once it's gone. */
async function nameOf(pid: number, proc: string): Promise<string | undefined> {
	try {
		return (await readFile(`${proc}/${pid}/comm`, "utf8")).trim();
	} catch {
		// It ended.
		return undefined;
	}
}
