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
 * orchestrator's ordered carry, `{"act": "ordered-carry", "to", "why", "by"}`,
 * which mycelium's node writes stamped with the orchestrator's address as
 * `by` and `from`, is read as `ordered`, never as an act, so nothing that
 * trusts the person's carry takes it (ISXEG8's condition 3, 15 November;
 * extensions/mesh-workflow/ordered-carry.ts). A carry mycelium's node
 * chose itself, to ease a machine whose kernel says it is stalling, comes
 * the same way with `node@<machine>` as `by` and `from`, kept as written,
 * so it reads as that node's, never an orchestrator's. Anything running
 * as the person that reaches the inbox can write either, so the name says
 * whom the steer claims, not who wrote it. The
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
import { isMachineName } from "../internal/machine/machine.ts";
import { isMoveTarget } from "../internal/session/move.ts";
import { type GivenAnswer, givenFrom } from "../internal/session/wants.ts";
import { writeWhole } from "../internal/write-whole.ts";
import {
	FROM_MACHINE,
	FROM_PERSON,
	HERE_READ_MS,
	type Here,
	hereHeld,
	hereOr,
	isFromPerson,
	nodeNamed,
	type OrderedCarry,
	orderedFrom,
} from "./steer-who.ts";
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

/** A program's name as a machine steer's `by` may give it. */
const PROGRAM_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** How the words a session is given for the machine's own steer open. */
export const MACHINE_SAYS = "[Said by this machine's ";

/** What follows the asker in the words a session is given for a steer from outside its window. */
export const ASKING_FROM_OUTSIDE = " is asking from outside this window";

/**
 * The askers the person's own steers read as, unnamed or by name, in
 * lower case, since the asker keeps the case of the `from` that
 * isFromPerson reads without it.
 */
const PERSON_ASKERS = new Set(["the person", FROM_PERSON, "joel"]);

/**
 * Whether `text`, as a session is given it, is a steer someone other
 * than the person wrote: the machine's, or a peer agent's asking from
 * outside the window, as extensions/mesh-workflow/steer.ts frames them.
 * Neither carries the automated header, so without this both read as
 * the person's words.
 */
export function isOthersSteerText(text: string): boolean {
	if (text.startsWith(MACHINE_SAYS)) return true;
	if (!text.startsWith("[")) return false;
	const at = text.indexOf(ASKING_FROM_OUTSIDE);
	const closed = text.indexOf("]");
	if (at < 0 || (closed >= 0 && closed < at)) return false;
	return !PERSON_ASKERS.has(text.slice(1, at).toLowerCase());
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
	/** The look an `answer` answers instead, by its id (lib/mesh/looks/looks.ts). */
	readonly look?: string;
	/** What an `answer` gives the ask: a choice's value, or words. */
	readonly given?: GivenAnswer;
	/**
	 * Whether its words go into the run under way, rather than waiting for
	 * it to end; only for words, never for an act.
	 */
	readonly now?: true;
	/**
	 * A carry an orchestrator ordered or this machine's node chose, which
	 * is never an act of the person's.
	 */
	readonly ordered?: OrderedCarry;
	/** The file it came in, for what is said about it on screen. */
	readonly file: string;
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
 * named by the millisecond it was written and random hex; answers the
 * file's name.
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

/**
 * A steer read from a file's text on the machine `here`, or nothing
 * when it is not one; with no `here`, a node's carry is none.
 */
export function steerFrom(
	raw: string,
	file: string,
	here?: string,
): Steer | undefined {
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
	const ordered = orderedFrom(parsed, from, here);
	if (ordered) {
		const at = "at" in parsed && typeof parsed.at === "string" ? parsed.at : "";
		const named = NAMED_AT.exec(file)?.[0];
		const put = named === undefined ? undefined : new Date(Number(named));
		return {
			text: "",
			ordered:
				put === undefined || Number.isNaN(put.getTime())
					? ordered
					: { ...ordered, put },
			...(at ? { at } : {}),
			from,
			file,
		};
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
 * The steers waiting in an inbox, in the order written, read off the thread
 * and left where they are for their own session to take: what is not a
 * steer, or was taken as it was read, is passed over. A clock reads every
 * parked peer's this way, and a host runs every conversation's clock on
 * one thread, so this machine's name, for a node's carry, is read off it
 * too, by `readOff` as the steers are. While a record there can't be read,
 * a node's carry is seen waiting refused, saying why, as the take hands
 * it on, and a parked session wakes to take it, reading the record again.
 */
export async function waitingSteers(
	inbox: string,
	readOff: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Steer[]> {
	let names: string[];
	try {
		names = await readdir(inbox);
	} catch {
		// No inbox: nothing was ever written to it.
		return [];
	}
	const read = await Promise.all(
		readyOf(names).map((name) =>
			readOff(join(inbox, name)).then(
				(raw) => ({ name, raw }),
				() => {
					// Taken by its session between the listing and the read.
					return undefined;
				},
			),
		),
	);
	const said = read.filter((one) => one !== undefined);
	const here = await hereOr(said, readOff);
	return inWrittenOrder(
		said
			.map(({ name, raw }) => steerHere(raw, name, here))
			.filter((steer): steer is Steer => steer !== undefined),
	);
}

/**
 * The steer `raw` is on the machine `here`. Where `here`'s record is
 * there but unread, a node's carry can't be told from another's, so it
 * is handed on refused, saying why, as another machine's node's is.
 * A parked session wakes to take it and reads the record again: read,
 * the carry goes ahead as any other; still unread, the refusal is said
 * on screen and written nowhere, and the node waits out its time. Read as
 * the node it names would have it, it is whole or nothing as it would
 * be then.
 */
function steerHere(raw: string, file: string, here: Here): Steer | undefined {
	const node = nodeNamed(raw);
	if (node === undefined || here === undefined) {
		return steerFrom(raw, file, undefined);
	}
	// Another machine's node runs none of this machine's sessions, so its
	// carry is refused, saying both names, rather than left to wait.
	const refused =
		typeof here === "object"
			? here.unread
			: node === here
				? undefined
				: `it names node@${node}, but this machine is ${here}, so it isn't this machine's node's carry`;
	const steer = steerFrom(raw, file, node);
	return steer?.ordered && refused !== undefined
		? { ...steer, ordered: { ...steer.ordered, refused } }
		: steer;
}

/**
 * Every steer waiting in an inbox, in the order written, each taken off
 * disk as it is read. Making the folder is part of looking, so a
 * writer finds it there once its peer has looked once. This machine's
 * record is read at the first node's carry, and while it is there but
 * can't be read, a node's carry is taken refused, saying why, as
 * `takenSteers` takes it. It reads on the thread, so it is for tests
 * alone: a session reads its inbox through `takenSteers`.
 */
export function takeSteers(inbox: string, taker: string): Taken {
	mkdirSync(inbox, { recursive: true });
	const taken: Taken = { steers: [], bad: [] };
	let here: Here;
	for (const name of readyOf(readdirSync(inbox))) {
		const taking = claim(inbox, name, taker);
		if (taking === undefined) continue;
		const raw = readFileSync(taking, "utf8");
		if (here === undefined && nodeNamed(raw) !== undefined) here = hereHeld();
		settle(inbox, name, taking, steerHere(raw, name, here), taken);
	}
	return { ...taken, steers: inWrittenOrder(taken.steers) };
}

/**
 * Every steer waiting in an inbox, as `takeSteers` takes them, with the
 * folder and each steer read off the thread: every conversation a host
 * holds looks at its inboxes on a clock, and a disk that stalls a
 * synchronous read holds them all. Each is read under its own name, and
 * then, only while `still` says the taker stands, all are claimed and
 * settled in one turn with what was read, so a taker ended while a read
 * waits leaves every steer waiting, never claimed and lost. A steer is
 * published whole by a rename and never rewritten under its name, so
 * what was read is what is claimed. While this machine's record is there
 * but can't be read, a node's carry is taken refused, saying why, and
 * every other steer as ever.
 */
export async function takenSteers(
	inbox: string,
	taker: string,
	readOff: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
	still: () => boolean = () => true,
	hereMs: number = HERE_READ_MS,
): Promise<Taken> {
	await mkdir(inbox, { recursive: true });
	const read: { name: string; raw: string }[] = [];
	for (const name of readyOf(await readdir(inbox))) {
		const raw = await readOff(join(inbox, name)).catch(() => {
			// Taken by another session, or withdrawn, since it was listed.
			return undefined;
		});
		if (raw !== undefined) read.push({ name, raw });
	}
	const here = await hereOr(read, readOff, hereMs);
	const taken: Taken = { steers: [], bad: [] };
	if (!still()) return taken;
	for (const { name, raw } of read) {
		const taking = claim(inbox, name, taker);
		if (taking !== undefined)
			settle(inbox, name, taking, steerHere(raw, name, here), taken);
	}
	return { ...taken, steers: inWrittenOrder(taken.steers) };
}

/** The steers ready to take among an inbox's `names`, by name. */
function readyOf(names: string[]): string[] {
	return names.filter((name) => name.endsWith(READY)).sort();
}

/**
 * `steers`, listed by name, in the order they were written, as far as
 * one take can tell: by the millisecond each name opens with, which its
 * writer put it on disk at by this machine's clock, then by the time the
 * steer says, then by name, as the sort keeps it. By name alone, two put
 * there in one millisecond went in their random hex's order, so a stop
 * and a talk given together reached pausing either way round. The name
 * leads because an `at` may come from another machine's clock, as the
 * node brings steers; it decides only a tie.
 */
function inWrittenOrder(steers: readonly Steer[]): Steer[] {
	return steers
		.map((steer) => ({ steer, ...writtenAt(steer) }))
		.sort((a, b) => a.put - b.put || a.said - b.said)
		.map(({ steer }) => steer);
}

/**
 * When a steer was put on disk and when it says it was written, in ms;
 * one that can't be read takes the other, and neither goes after all.
 */
function writtenAt(steer: Steer): { put: number; said: number } {
	const named = NAMED_AT.exec(steer.file)?.[0];
	const put = named === undefined ? Number.NaN : Number(named);
	const said = steer.at === undefined ? Number.NaN : Date.parse(steer.at);
	const either = Number.isNaN(put) ? said : put;
	const known = Number.isNaN(either) ? Number.POSITIVE_INFINITY : either;
	return {
		put: Number.isNaN(put) ? known : put,
		said: Number.isNaN(said) ? known : said,
	};
}

/** The millisecond a steer's file name opens with. */
const NAMED_AT = /^\d+/;

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
 * let go, or set aside as bad when it is not a steer. A claim that can't
 * be let go or set aside costs only itself: what it read is still
 * delivered or said to be bad, and the steers around it still are.
 */
function settle(
	inbox: string,
	name: string,
	taking: string,
	steer: Steer | undefined,
	taken: Taken,
): void {
	if (steer) {
		taken.steers.push(steer);
		leave(() => unlinkSync(taking));
	} else {
		taken.bad.push(name);
		leave(() => renameSync(taking, `${join(inbox, name)}${BAD}`));
	}
}

/** Let a claimed file go, or set it aside, as `step` does, if the disk allows. */
function leave(step: () => void): void {
	try {
		step();
	} catch {
		// Left under its claim name, which no look reads again.
	}
}
