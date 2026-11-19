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
 * over to it, and a spawner that never gets its name is never named,
 * which is said like a refusal.
 *
 * It stops a command claiming another session's spawner; it doesn't stop
 * code running inside the host itself, as an extension a project brings
 * or a reload onto another tree, which can say what it likes, nor a
 * command that rewrites the harness's files and restarts the host, whose
 * next start runs that code, or writes pi's host records and starts a
 * Node.js of its own that passes the node's checks; only a fence round
 * every conversation's commands does. A refusal, a node that listens
 * yet never answers or hangs up, or a spawner late to its name, is said
 * once for each reason on the host's error output, as the node logs
 * each refusal. The
 * node keeps the word only while it runs, so spawner.ts says it again
 * every 30 seconds while the spawner runs. Where no node's socket is
 * there, nothing is said and the spawner's commands are told no
 * session, as before; a socket a node that ended left behind is said to
 * answer nothing. A node that doesn't know the word refuses it, and
 * that refusal is said like any other, as is an answer that neither
 * takes nor refuses it. With no /proc, as
 * on a Mac, there is no tick to read, and nothing is said. A command a
 * host's restart keeps runs on under a spawner the next host didn't
 * start, and so is told no session from then on.
 */

import { readFile, stat } from "node:fs/promises";
import { askAt, nodeSocket } from "../../mesh/node.ts";
import { processGlobal } from "../process/process-global.ts";

/** How long the host waits on the node's answer, at most. */
export const REGISTER_PATIENCE_MS = 2000;

/**
 * How long the host waits for the spawner to go by its own name, at most:
 * a scoped start's systemd-run asks the user's manager first, which a
 * busy machine slows, and the node's answer gets its own time after.
 */
export const NAME_PATIENCE_MS = 2000;

/**
 * How near its patience an unanswered ask counts as the node's silence
 * rather than its hanging up: a timer may fire a little before the
 * monotonic clock says its time is up.
 */
const SILENCE_SLACK_MS = 50;

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
 * out, whatever is said. A refusal, a node listening that never answers
 * or hangs up, or a spawner late to its name, is said once for each
 * reason on the host's error output.
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
	const named = await namedSpawner(pid, proc, performance.now() + namePatience);
	if (named === "gone") return;
	// A late name is said only where a node listens to be told it.
	if (named === "late" && !(await listening(socket))) return;
	const why =
		named === "late"
			? `pi-spawner didn't go by its own name within ${namePatience} ms`
			: await refusalOf(socket, { pid, started, session }, patience);
	if (why === undefined) return;
	// A spawner's pid, or the session, makes no reason of its own, and a
	// reason is kept only as far as it's said.
	const reason = cut(why.split(session).join("").replace(/\d+/g, ""));
	if (saidRefusals.has(reason) || saidRefusals.size > REFUSALS_SAID) return;
	saidRefusals.add(reason);
	const say = options.say ?? ((line) => process.stderr.write(line));
	if (saidRefusals.size > REFUSALS_SAID) {
		say(
			`pi-spawner's host has said ${REFUSALS_SAID} reasons the mycelium node refused, and says no more until it restarts\n`,
		);
		return;
	}
	// Whoever answers on the socket wrote it, so no control, format or
	// line-breaking character reaches the host's journal.
	const said = cut(why.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "?"));
	say(
		`pi-spawner's session isn't named to the mycelium node, so its commands are told no conversation: ${said}\n`,
	);
}

/** How much of a refusal's reason is said, at most, in characters. */
const REFUSAL_CHARS = 300;

/**
 * `text` up to REFUSAL_CHARS characters, a cut marked; counted by code
 * point, so no character is split in two.
 */
function cut(text: string): string {
	const characters = Array.from(text);
	return characters.length > REFUSAL_CHARS
		? `${characters.slice(0, REFUSAL_CHARS).join("")}...`
		: text;
}

/**
 * Why the node at `socket` didn't take the word, or nothing once it did
 * or no node is there: its refusal; its silence, when patience ran out;
 * or, when it hung up or refused the connection sooner, as a node that
 * ended and left its socket behind does, that nothing answered.
 */
async function refusalOf(
	socket: string,
	spawned: Spawned & { session: string },
	patience: number,
): Promise<string | undefined> {
	const asked = performance.now();
	const answer = await askAt(socket, { Spawned: spawned }, patience);
	if (answer !== undefined) return refusalIn(answer);
	if (!(await listening(socket))) return undefined;
	return performance.now() - asked >= patience - SILENCE_SLACK_MS
		? `the mycelium node didn't answer within ${patience} ms`
		: "nothing answered at the mycelium node's socket";
}

/** Whether something stands at `socket` to answer, as a node would. */
async function listening(socket: string): Promise<boolean> {
	try {
		return (await stat(socket)).isSocket();
	} catch {
		// No node here, which is no reason to say.
		return false;
	}
}

/**
 * The reasons a node refused the word, each said once on the host's
 * error output, as the node says each once in its own log. A reason is
 * kept without its numbers or the session, so refusals of one spawner
 * after another, or of one conversation after another, count as one,
 * and the node's few reasons never fill REFUSALS_SAID. It is the
 * process's, not this module's, since pi loads the extension afresh for
 * each conversation a host opens and each reload.
 */
const saidRefusals = processGlobal(
	"agentic-harness.shell/spawner-register-said",
	() => new Set<string>(),
);

/**
 * How many reasons a host says at most, so one running for weeks never
 * grows with spawners refused one by one.
 */
const REFUSALS_SAID = 32;

/**
 * The node's reason, when its answer refuses the word; nothing, when it
 * takes it; and that it can't be read, when it answers neither way, as
 * a node speaking another shape would.
 */
function refusalIn(answer: string): string | undefined {
	let reply: unknown;
	try {
		reply = JSON.parse(answer);
	} catch {
		return UNREADABLE;
	}
	if (typeof reply !== "object" || reply === null) return UNREADABLE;
	if ("Ok" in reply && reply.Ok === "Spawned") return undefined;
	if ("Err" in reply && typeof reply.Err === "string") return reply.Err;
	return UNREADABLE;
}

/** What's said of an answer that neither takes nor refuses the word. */
const UNREADABLE =
	"the mycelium node answered in a way this harness can't read";

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

/**
 * Whether `pid` goes by pi-spawner's name before `until`: named; gone,
 * once it has ended or /proc doesn't hold it; or late, still going by
 * another name when `until` comes.
 */
async function namedSpawner(
	pid: number,
	proc: string,
	until: number,
): Promise<"named" | "gone" | "late"> {
	for (;;) {
		const name = await nameOf(pid, proc);
		if (name === SPAWNER_NAME) return "named";
		if (name === undefined) return "gone";
		if (performance.now() >= until) return "late";
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
