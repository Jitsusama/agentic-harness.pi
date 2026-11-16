/**
 * The steer inbox: what the person says to one peer from outside its
 * window, such as the launcher's Steer box, delivered to it as the
 * person's own message rather than as a peer's on the mesh.
 *
 * Joel, 2026-10-25: "i really need to be able to have some interface i
 * can steer on". A mesh message would not do: peers read those as
 * context from other agents, and attention can make one a note, so a
 * pivot from the person would lose its authority on the way.
 *
 * Each peer address has a folder, `<root>/<ADDRESS>/`. A writer puts a
 * file there under a temporary name and renames it to end in `.json`,
 * holding `{"text": "...", "at": "<ISO time>", "from": "joel"}`, and
 * an `id` when the writer wants to follow what becomes of it (see
 * talk.ts), with `re` naming the earlier talk it answers in place. An `act` of `pause`, `resume`, `stop`, `close`, `carry` or
 * `move` needs no text, a `carry` names the machine it goes to as `to`,
 * a `move` names where it goes as `to` (`attended`, `background` or
 * `pi`), and a `fill` puts its `text` in the prompt without sending it.
 * An `answer` answers the open ask the session's want `want` names, with
 * one of its choices as `value` or the person's words as `other`, or the
 * look `look` names with one of its choices as `value`. Words reach a
 * session at work once its run ends, unless the steer holds `"now": true`,
 * which reads them into the run under way, after its current tool: the
 * person says when to break into a task (Joel, 12 November: a message
 * to a session mid-task waits for its turn to end unless he says now). A
 * program of the machine's writes `"from": "machine"` and may name itself
 * as `by` (`"by": "nix-offload"`), which the session is told. An
 * orchestrator's carry, `{"act": "ordered-carry", "to", "why", "by"}`,
 * which mycelium's node writes stamped with the orchestrator's address as
 * `by` and `from`, is read as `ordered`, never as an act, so nothing that
 * trusts the person's carry takes it (ISXEG8's condition 3, 15 November;
 * extensions/mesh-workflow/ordered-carry.ts). The
 * session going by that address takes it by renaming it again, so two
 * sessions looking at once deliver it once, then reads and removes it.
 * A file that is not a steer is set aside as `.bad`, never retried.
 */

import { randomBytes } from "node:crypto";
import {
	type Dirent,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMachineName } from "../internal/machine.ts";
import { isMoveTarget } from "../internal/session/move.ts";
import { type GivenAnswer, givenFrom } from "../internal/session/wants.ts";
import { writeWhole } from "../internal/write-whole.ts";
import { isTalkId } from "./talk.ts";

/**
 * What the person may do to a session besides talk: pause it after its
 * current step, resume it, stop the run in progress, close the session
 * for good, as /exit does, carry its work to another machine and then
 * close it, move it into a host or back out of one once nothing of its
 * own is out (lib/internal/session/move.ts), or fill its prompt with
 * words left for the person to send.
 * Joel, 8 November, of a to-do that sends him to a session: "it should
 * give me a prompt that gets filled into it stating i'm reayd to deal
 * with it if it is still valid".
 */
export const STEER_ACTS = [
	"pause",
	"resume",
	"fill",
	"stop",
	"close",
	"carry",
	"move",
	"answer",
] as const;

/** One of STEER_ACTS. */
export type SteerAct = (typeof STEER_ACTS)[number];

function isSteerAct(value: unknown): value is SteerAct {
	return (STEER_ACTS as readonly unknown[]).includes(value);
}

/**
 * The `from` a machine's mycelium node writes, for what the machine itself
 * must say to a session it holds, as that it leaves at a set time. It is
 * never the person's word, so it carries no act.
 */
export const FROM_MACHINE = "machine";

/** A program's name as a machine steer's `by` may give it. */
const PROGRAM_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** The act an orchestrator's carry is written with, apart from STEER_ACTS. */
export const ORDERED_CARRY = "ordered-carry";

/** A peer's address, a quest's six or a session's eight, as `by` names one. */
const ADDRESS = /^[A-Za-z0-9]{6,8}$/;

/** The most an ordered carry's `why` says, so it reads as a reason. */
const MOST_WHY = 500;

/** A carry an orchestrator ordered, as the node stamped it. */
export interface OrderedCarry {
	/** The machine it goes to, as it names itself. */
	readonly to: string;
	/** Why, in the orchestrator's words. */
	readonly why: string;
	/** The orchestrator's address, which the node proved ordered it. */
	readonly by: string;
}

/**
 * The `from` mycelium's node writes for what the person asked through it,
 * as `mycelium carry` steers each session with.
 */
export const FROM_PERSON = "person";

/**
 * Whether a steer's writer is the person: one who names nobody, Joel, or
 * the node writing on the person's word.
 */
export function isFromPerson(from: string | undefined): boolean {
	if (from === undefined || from === "") return true;
	const who = from.toLowerCase();
	return who === "joel" || who === FROM_PERSON;
}

/**
 * Whether a steer is the person's own words starting a turn they wait on:
 * a talk, or a resume with words, written by Joel or by the node on his
 * word. The traffic shaper sends such a turn's request ahead of agents'
 * (lib/internal/priority/typed.ts), so this names the writer outright:
 * an agent's steer, the machine's, a bare act or an answer is none.
 */
export function isPersonsTalk(
	steer: Pick<Steer, "text" | "act" | "from">,
): boolean {
	if (steer.text.trim() === "") return false;
	if (steer.act !== undefined && steer.act !== "resume") return false;
	const who = steer.from?.toLowerCase();
	return who === "joel" || who === FROM_PERSON;
}

/** One thing the person said, as the inbox carries it. */
export interface Steer {
	/**
	 * Their words; empty only for an act, and kept only beside `resume`,
	 * since words would start the run a pause or stop is ending.
	 */
	readonly text: string;
	/** What they did besides talk, when they did. */
	readonly act?: SteerAct;
	/**
	 * The machine a carry goes to, as it names itself, beside `carry`; or
	 * where a move goes, beside `move`.
	 */
	readonly to?: string;
	/** When it was written, as an ISO time, if the writer said. */
	readonly at?: string;
	/** Who wrote it, if the writer said; the launcher says "joel". */
	readonly from?: string;
	/**
	 * Which of the machine's programs wrote it, beside a `from` of
	 * "machine": the node when none is named, or a daemon such as
	 * nix-offload telling integration no builder answers (5FWIUS).
	 */
	readonly by?: string;
	/** The talk it opens, when the writer gave one (see talk.ts). */
	readonly id?: string;
	/** The earlier talk it answers in place, when the writer said. */
	readonly re?: string;
	/** The want an `answer` answers, by its id (lib/mesh/want.ts). */
	readonly want?: string;
	/** The look an `answer` answers instead, by its id (lib/mesh/looks.ts). */
	readonly look?: string;
	/** What an `answer` gives the ask: a choice's value, or words. */
	readonly given?: GivenAnswer;
	/**
	 * Whether its words go into the run under way, rather than waiting for
	 * it to end; only for words, never for an act.
	 */
	readonly now?: true;
	/** An orchestrator's carry, which is never an act of the person's. */
	readonly ordered?: OrderedCarry;
	/** The file it came in, for what is said about it on screen. */
	readonly file: string;
}

/**
 * The ordered carry a steer holds, or nothing unless it is whole and
 * from an orchestrator: `from` and `by` one address, never the person or
 * the machine, a machine's name to go to, and a reason.
 */
function orderedFrom(parsed: object, from: string): OrderedCarry | undefined {
	if (!("act" in parsed) || parsed.act !== ORDERED_CARRY) return undefined;
	const by = "by" in parsed ? parsed.by : undefined;
	const to = "to" in parsed ? parsed.to : undefined;
	const why =
		"why" in parsed && typeof parsed.why === "string" ? parsed.why.trim() : "";
	if (typeof by !== "string" || !ADDRESS.test(by)) return undefined;
	if (from.toUpperCase() !== by.toUpperCase()) return undefined;
	if (!isMachineName(to) || why === "" || why.length > MOST_WHY) {
		return undefined;
	}
	return { to, why, by: by.toUpperCase() };
}

/** What taking the inbox found: steers to deliver, and files set aside. */
export interface Taken {
	readonly steers: Steer[];
	readonly bad: string[];
}

const READY = ".json";
const TAKEN = ".taking";
const BAD = ".bad";

/** The inbox folder of one peer address. */
export function inboxOf(root: string, address: string): string {
	return join(root, address.toUpperCase());
}

/**
 * Write a steer into an address's inbox whole, as the launcher does,
 * named by when it was written so it sorts after those before it;
 * answers the file's name.
 */
export function giveSteer(
	root: string,
	address: string,
	steer: Omit<Steer, "file">,
): string {
	const name = `${Date.now()}-${randomBytes(4).toString("hex")}${READY}`;
	writeWhole(join(inboxOf(root, address), name), JSON.stringify(steer));
	return name;
}

/** A steer read from a file's text, or nothing when it is not one. */
export function steerFrom(raw: string, file: string): Steer | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Not JSON at all: the caller sets it aside as not a steer.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const from =
		"from" in parsed && typeof parsed.from === "string" ? parsed.from : "";
	const ordered = orderedFrom(parsed, from);
	if (ordered) {
		const at = "at" in parsed && typeof parsed.at === "string" ? parsed.at : "";
		return { text: "", ordered, ...(at ? { at } : {}), from, file };
	}
	// Only the person may pause, resume, stop, close, carry or move a session.
	const asked =
		"act" in parsed && isSteerAct(parsed.act) && isFromPerson(from)
			? parsed.act
			: undefined;
	const goes = "to" in parsed ? parsed.to : undefined;
	const to =
		(asked === "carry" && isMachineName(goes)) ||
		(asked === "move" && isMoveTarget(goes))
			? goes
			: undefined;
	const said =
		"text" in parsed && typeof parsed.text === "string"
			? parsed.text.trim()
			: "";
	const want =
		asked === "answer" && "want" in parsed && typeof parsed.want === "string"
			? parsed.want
			: undefined;
	const look =
		asked === "answer" &&
		want === undefined &&
		"look" in parsed &&
		typeof parsed.look === "string"
			? parsed.look
			: undefined;
	const given = asked === "answer" ? givenFrom(parsed) : undefined;
	// A carry or move goes nowhere without a to, nor a fill without words,
	// nor an answer without what it answers and what it gives; a look
	// takes only one of its choices.
	const act =
		((asked === "carry" || asked === "move") && to === undefined) ||
		(asked === "fill" && said === "") ||
		(asked === "answer" &&
			(given === undefined ||
				(want === undefined && look === undefined) ||
				(look !== undefined && !("value" in given))))
			? undefined
			: asked;
	// Words would start the run a pause, stop or close is ending.
	const text = act && act !== "resume" && act !== "fill" ? "" : said;
	if (!act && text === "") return undefined;
	const at = "at" in parsed && typeof parsed.at === "string" ? parsed.at : "";
	const id = "id" in parsed && isTalkId(parsed.id) ? parsed.id : undefined;
	const re = "re" in parsed && isTalkId(parsed.re) ? parsed.re : undefined;
	const now =
		text !== "" && "now" in parsed && parsed.now === true ? true : undefined;
	const by =
		from === FROM_MACHINE &&
		"by" in parsed &&
		typeof parsed.by === "string" &&
		PROGRAM_NAME.test(parsed.by)
			? parsed.by
			: undefined;
	return {
		text,
		...(act ? { act } : {}),
		...(to ? { to } : {}),
		...(at ? { at } : {}),
		...(from ? { from } : {}),
		...(by ? { by } : {}),
		...(id ? { id } : {}),
		...(re ? { re } : {}),
		...(now ? { now } : {}),
		...(act === "answer" && want ? { want } : {}),
		...(act === "answer" && look ? { look } : {}),
		...(act === "answer" && given ? { given } : {}),
		file,
	};
}

/**
 * Let go of the inboxes of addresses nobody answers now. Each session
 * makes one for its own address and one for its quest's the first time
 * it looks, so without this the folder grew by two for every session
 * the machine ever ran: 118 on 2026-10-29, when a burst of ten in six
 * minutes set the launcher, which lists them, crash-looping.
 *
 * An empty inbox goes once it is older than `quietSince`, so a session
 * that has just made its own, ahead of publishing who it is, keeps it.
 * One holding anything, such as a steer for a session that may yet be
 * restored or a talk's replies, goes once nothing in it has changed
 * since `keptSince`. Returns the addresses let go.
 */
export function forgetInboxes(
	root: string,
	answered: ReadonlySet<string>,
	quietSince: number,
	keptSince: number,
): string[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const forgotten: string[] = [];
	for (const name of names) {
		if (answered.has(name)) continue;
		const inbox = join(root, name);
		const last = lastChange(inbox);
		if (last === undefined) continue;
		if (last.at >= (last.empty ? quietSince : keptSince)) continue;
		try {
			rmSync(inbox, { recursive: true, force: true });
			forgotten.push(name);
		} catch {
			// Left for the next sweep, which tries again.
		}
	}
	return forgotten;
}

/**
 * When anything in a folder last changed, and whether it holds no file
 * at all; undefined when it is not a folder that can be read.
 */
function lastChange(dir: string): { at: number; empty: boolean } | undefined {
	let at: number;
	let entries: Dirent[];
	try {
		const own = statSync(dir);
		if (!own.isDirectory()) return undefined;
		at = own.mtimeMs;
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	let empty = true;
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			const inner = lastChange(path);
			if (!inner) continue;
			at = Math.max(at, inner.at);
			empty &&= inner.empty;
			continue;
		}
		empty = false;
		try {
			at = Math.max(at, statSync(path).mtimeMs);
		} catch {
			// Gone as it was read, as a steer taken meanwhile is: still not empty.
		}
	}
	return { at, empty };
}

/**
 * The steers waiting in an inbox, oldest name first, read off the thread
 * and left where they are for their own session to take: what is not a
 * steer, or was taken as it was read, is passed over. A clock reads every
 * parked peer's this way, and a host runs every conversation's clock on
 * one thread.
 */
export async function waitingSteers(inbox: string): Promise<Steer[]> {
	let names: string[];
	try {
		names = await readdir(inbox);
	} catch {
		// No inbox: nothing was ever written to it.
		return [];
	}
	const read = await Promise.all(
		readyOf(names).map((name) =>
			readFile(join(inbox, name), "utf8").then(
				(raw) => steerFrom(raw, name),
				() => {
					// Taken by its session between the listing and the read.
					return undefined;
				},
			),
		),
	);
	return read.filter((steer): steer is Steer => steer !== undefined);
}

/**
 * Every steer waiting in an inbox, oldest name first, each taken off
 * disk as it is read. Making the folder is part of looking, so a
 * writer finds it there once its peer has looked once.
 */
export function takeSteers(inbox: string, taker: string): Taken {
	mkdirSync(inbox, { recursive: true });
	const taken: Taken = { steers: [], bad: [] };
	for (const name of readyOf(readdirSync(inbox))) {
		const taking = claim(inbox, name, taker);
		if (taking !== undefined)
			settle(inbox, name, taking, readFileSync(taking, "utf8"), taken);
	}
	return taken;
}

/**
 * Every steer waiting in an inbox, as `takeSteers` takes them, with the
 * folder and each steer read off the thread: every conversation a host
 * holds looks at its inboxes on a clock, and a disk that stalls a
 * synchronous read holds them all. Taking each stays a rename at once,
 * so a steer is never half taken.
 */
export async function takenSteers(
	inbox: string,
	taker: string,
): Promise<Taken> {
	await mkdir(inbox, { recursive: true });
	const taken: Taken = { steers: [], bad: [] };
	for (const name of readyOf(await readdir(inbox))) {
		const taking = claim(inbox, name, taker);
		if (taking !== undefined)
			settle(inbox, name, taking, await readFile(taking, "utf8"), taken);
	}
	return taken;
}

/** The steers ready to take among an inbox's `names`, oldest first. */
function readyOf(names: string[]): string[] {
	return names.filter((name) => name.endsWith(READY)).sort();
}

/**
 * The steer `name` taken off its inbox for `taker`, answering where it
 * now lies; none when another session took it first, or its writer
 * withdrew it.
 */
function claim(inbox: string, name: string, taker: string): string | undefined {
	const taking = `${join(inbox, name)}.${taker}${TAKEN}`;
	try {
		renameSync(join(inbox, name), taking);
		return taking;
	} catch {
		// Another session took it first, or its writer withdrew it.
		return undefined;
	}
}

/**
 * The steer taken to `taking`, which read `raw`, added to `taken` and
 * let go, or set aside as bad when it is not a steer.
 */
function settle(
	inbox: string,
	name: string,
	taking: string,
	raw: string,
	taken: Taken,
): void {
	const steer = steerFrom(raw, name);
	if (steer) {
		taken.steers.push(steer);
		unlinkSync(taking);
	} else {
		renameSync(taking, `${join(inbox, name)}${BAD}`);
		taken.bad.push(name);
	}
}
