/**
 * An agent's ask for one work secret, as core's passwords daemon reads it,
 * and the secret-asks daemon before it: a file `<id>.ask.json` in the asks folder (the shape's version 1),
 * and the answer the daemon writes beside it, `<id>.answer.json`, once
 * Joel says yes or no in the launcher or the ask runs out.
 *
 * The harness only writes the ask and reads the answer's fields; the value
 * goes from 1Password to the command the line names and never comes back
 * here. An ask the daemon would refuse is refused before it's written, so
 * an agent learns why at once rather than after Joel has seen a line.
 *
 * Only pi asks, from outside the fence: the daemon takes a yes from
 * anything that reaches its socket (core's secret-asks `daemon.rs`), so
 * no fenced command reaches it or the asks, and one naming the daemon's
 * program is told to use secret_run instead.
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { quoted } from "../sandbox/sandbox-shell.ts";
import { writeWhole } from "../write-whole.ts";

/** What a fenced command naming the daemon's program is told. */
const FENCED_NOTE =
	"pi: a fenced command can't reach secret-asks, since anything that reaches it could say yes to an ask; ask for the secret with the secret_run tool, which asks Joel from outside the fence.";

/** The shape's version the daemon reads. */
export const ASK_VERSION = 1;

/** The longest a released command may run, in minutes, as the daemon says. */
export const LONGEST_MINUTES = 30;

/** The longest reason an ask may give, so the line stays one line. */
export const LONGEST_WHY = 200;

/**
 * Variables a command's start reads before it reads its own, so a value
 * given as one of them would be read by what starts the command.
 */
const NEVER_GIVEN = new Set([
	"PATH",
	"HOME",
	"LANG",
	"BASH_ENV",
	"ENV",
	"SHELL",
]);

/** What an ask says, the id and the moment aside. */
export interface SecretAsk {
	/** The session asking, named by pi rather than the agent. */
	readonly session: string;
	/** The session's quest, when it holds one. */
	readonly quest?: { readonly id: string; readonly title: string };
	/** The 1Password reference, `op://<vault>/<item>/<field>`. */
	readonly item: string;
	/** Why, in one line. */
	readonly why: string;
	/** The command, as words: what Joel reads is what runs. */
	readonly argv: readonly string[];
	/** The folder it runs in, absolute. */
	readonly tree: string;
	/** The variable the value goes in. */
	readonly given: string;
	/** How long it may run. */
	readonly minutes: number;
}

/** How an ask ended, as its answer says it. */
export interface SecretAnswer {
	/** ran, refused, expired, failed, or another the daemon names. */
	readonly state: string;
	/** The command's exit code; null when it was stopped at its limit. */
	readonly exit?: number | null;
	/** What the command printed, masked and capped by the daemon. */
	readonly output?: string;
	/** Whether the output was cut at its cap. */
	readonly cut?: boolean;
	/** Why it ended as it did, or nothing when it ran to its end. */
	readonly why: string;
}

/**
 * Whether a variable's name may carry a value: capitals, digits and
 * underscores, not starting with a digit, at most 64 characters, and none
 * a command's start reads.
 */
export function mayBeGiven(name: string): boolean {
	return (
		/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) &&
		!NEVER_GIVEN.has(name) &&
		!name.startsWith("LD_")
	);
}

/** Why the daemon would refuse the ask, or nothing when it would read it. */
function refusal(ask: SecretAsk): string | undefined {
	if (!/^op:\/\/[^/]+\/[^/]+\/[^/]+$/.test(ask.item)) {
		return `${ask.item} isn't an op://<vault>/<item>/<field> reference`;
	}
	if (ask.argv.length === 0) return "an ask needs a command";
	if (!mayBeGiven(ask.given)) return `${ask.given} can't carry a value`;
	if (
		!Number.isInteger(ask.minutes) ||
		ask.minutes < 1 ||
		ask.minutes > LONGEST_MINUTES
	) {
		return `${ask.minutes} minutes is outside 1 to ${LONGEST_MINUTES}`;
	}
	if (/[\r\n]/.test(ask.why)) return "the why must be one line";
	if (ask.why.length > LONGEST_WHY) {
		return `the why runs past ${LONGEST_WHY} characters`;
	}
	return undefined;
}

/** What the route reads of the machine, given so a test can say it. */
export interface RouteReads {
	readonly exists: (path: string) => boolean;
	/** A file's text, or nothing when it can't be read. */
	readonly read: (path: string) => string | undefined;
	/** Whether the process with this pid is core's passwords daemon, as this account. */
	readonly daemon: (pid: number) => boolean;
}

/**
 * Whether the process with this pid is core's passwords program, run by
 * this account, by the name and real uid its status gives. The daemon
 * turns its dumpable flag off before it leaves its sign, which hides its
 * exe link even from its own account, while its status stays readable.
 * The name is the one the kernel took from the program's file at exec, so
 * another program of Joel's that a reused pid now names doesn't read as
 * the daemon, and nor does another account's. Where there's no /proc, as
 * on a Mac, nothing does, which is right: the daemon runs only on Linux.
 */
export function runsPasswords(
	pid: number,
	proc = "/proc",
	// Where there's no account to compare, no status names -1.
	uid: number = process.getuid?.() ?? -1,
): boolean {
	let status: string;
	try {
		status = readFileSync(join(proc, String(pid), "status"), "utf8");
	} catch {
		// Gone, or no /proc: none is the daemon.
		return false;
	}
	const name = /^Name:\t(.*)$/m.exec(status)?.[1];
	const real = /^Uid:\t(\d+)\t/m.exec(status)?.[1];
	return name === "passwords" && real === String(uid);
}

const MACHINE: RouteReads = {
	exists: existsSync,
	read: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			// A sign that can't be read says nothing is answering.
			return undefined;
		}
	},
	daemon: (pid) => runsPasswords(pid),
};

/**
 * Whether something answers the asks filed in the runtime folder: core's
 * secret-asks daemon, by its socket, or core's passwords daemon, by the
 * sign it leaves in the asks folder while it answers them, `answering`,
 * holding its pid (core's passwords `main.rs`). A sign whose pid isn't
 * the passwords program now is one a killed daemon left behind, its pid
 * since gone or reused, and says nothing.
 */
export function asksAnswered(
	runtime: string,
	reads: RouteReads = MACHINE,
): boolean {
	if (reads.exists(join(runtime, "daemons", "secret-asks.sock"))) return true;
	const sign = reads.read(join(runtime, "secret-asks", "answering"));
	const pid = sign?.trim();
	if (!(pid && /^[1-9][0-9]*$/.test(pid))) return false;
	return reads.daemon(Number(pid));
}

/**
 * Where secret_run files its asks, or why it can't from here: only from a
 * session whose commands are fenced, since only the fence keeps them from
 * the asks, and only where something answers them (`asksAnswered`).
 * Nothing is filed, so the pre-flight checks the whole route without
 * asking Joel.
 */
export function askRoute(
	place: { readonly fenced: boolean; readonly runtimeDir: string | undefined },
	reads: RouteReads = MACHINE,
): { readonly folder: string } | { readonly refused: string } {
	if (!place.fenced) {
		return {
			refused:
				"secret_run is refused while this session's commands run outside the agent fence, since only the fence keeps them from the asks. Ask Joel in words instead.",
		};
	}
	const runtime = place.runtimeDir;
	if (!(runtime && asksAnswered(runtime, reads))) {
		return {
			refused:
				"secret_run needs core's passwords or secret-asks daemon answering asks, and neither does on this machine. Ask Joel in words instead.",
		};
	}
	return { folder: join(runtime, "secret-asks") };
}

/**
 * `command`, preceded by a note on stderr saying secret_run is the way to
 * a secret when it names the daemon's program, which a fenced command
 * never reaches. Only a note: a command that merely names it, as a search
 * does, still runs.
 */
export function withSecretNote(command: string): string {
	if (!/(^|[^\w.-])secret-asks($|[^\w.-])/.test(command)) return command;
	return `printf '%s\\n' ${quoted(FENCED_NOTE)} >&2\n${command}`;
}

/**
 * Put an ask in the asks folder, made Joel's alone, written whole so the
 * daemon never reads half of it, and say its id and file.
 *
 * @throws When the daemon would refuse it, saying why, with nothing written.
 */
export function putAsk(
	folder: string,
	ask: SecretAsk,
	now: () => number = Date.now,
): { id: string; file: string } {
	const why = refusal(ask);
	if (why) throw new Error(why);
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	// A folder made before by something else keeps its mode; the asks in it
	// name items and commands, so it's held to Joel alone either way.
	chmodSync(folder, 0o700);
	const id = randomBytes(16).toString("hex");
	const file = join(folder, `${id}.ask.json`);
	const said = {
		version: ASK_VERSION,
		id,
		asked_ms: now(),
		session: ask.session,
		quest: ask.quest ? { id: ask.quest.id, title: ask.quest.title } : null,
		item: ask.item,
		why: ask.why,
		argv: [...ask.argv],
		tree: ask.tree,
		given: ask.given,
		minutes: ask.minutes,
	};
	writeWhole(file, JSON.stringify(said));
	return { id, file };
}

/**
 * The ask's answer, once the daemon has written it: only the fields an
 * agent may see. Nothing while there's none, or when the file there isn't
 * this ask's answer.
 */
export function answerOf(folder: string, id: string): SecretAnswer | undefined {
	let said: unknown;
	try {
		said = JSON.parse(readFileSync(join(folder, `${id}.answer.json`), "utf8"));
	} catch {
		// Not written yet, or caught as it was being renamed into place.
		return undefined;
	}
	if (typeof said !== "object" || said === null) return undefined;
	const field = (name: string): unknown => Reflect.get(said, name);
	const state = field("state");
	if (field("version") !== ASK_VERSION || field("id") !== id) return undefined;
	if (typeof state !== "string") return undefined;
	const answer: {
		state: string;
		exit?: number | null;
		output?: string;
		cut?: boolean;
		why: string;
	} = {
		state,
		why: typeof field("why") === "string" ? String(field("why")) : "",
	};
	const exit = field("exit");
	if (typeof exit === "number" || exit === null) answer.exit = exit;
	const output = field("output");
	if (typeof output === "string") answer.output = output;
	const cut = field("cut");
	if (typeof cut === "boolean") answer.cut = cut;
	return answer;
}

/**
 * Take an ask back, its answer with it: on an abort, a stopped job or a
 * session's end, so its line leaves Joel's screen at once, and once its
 * answer is read.
 */
export function takeAsk(folder: string, id: string): void {
	rmSync(join(folder, `${id}.ask.json`), { force: true });
	rmSync(join(folder, `${id}.answer.json`), { force: true });
}
