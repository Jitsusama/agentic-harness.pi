/**
 * An agent's ask for one work secret, as core's secret-asks daemon reads
 * it: a file `<id>.ask.json` in the asks folder (the shape's version 1),
 * and the answer the daemon writes beside it, `<id>.answer.json`, once
 * Joel says yes or no in the launcher or the ask runs out.
 *
 * The harness only writes the ask and reads the answer's fields; the value
 * goes from 1Password to the command the line names and never comes back
 * here. An ask the daemon would refuse is refused before it's written, so
 * an agent learns why at once rather than after Joel has seen a line.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeWhole } from "./write-whole.ts";

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
