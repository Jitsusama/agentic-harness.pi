/**
 * Parking a question the person isn't there to answer.
 *
 * At 03:17 on 14 November a session asked while Joel slept, and its ask
 * held the session until 08:55: peers' questions waited on it, a host
 * restart waited on them, and a night's drill missed its window. Away
 * mode was off, since he never said he was leaving. Joel at 09:07: "we
 * need to rejig ask so this can't happen again."
 *
 * So an ask never holds a turn for long. Left unanswered for
 * {@link PARK_AFTER_MS}, or asked while his screen is locked or he's
 * away from it, the question parks: it comes off the screen, goes on his
 * look list with its choices, opening the session's window, and the tool
 * says it was parked unanswered so the session carries on. What he picks
 * there comes back to the session as a message, as any look's answer
 * does (mesh-workflow's steer). Nothing is decided for him: a parked
 * question takes no recommendation, which only away mode does.
 *
 * Whether he's there is read from the shell's own files in the runtime
 * folder: "locked" in quickshell-locked while the lock is up, and "away"
 * in quickshell-away after ten minutes with no input and nothing holding
 * the screen awake, as a call or a video does. No file, or a word it
 * doesn't know, reads as there, so a machine without the shell parks
 * only on the timeout.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadedQuest } from "../../lib/mesh/address.ts";
import {
	type Look,
	type Pointer,
	type Pointing,
	pointAt,
	refusalOf,
} from "../../lib/mesh/looks.ts";
import { createPresences } from "../../lib/mesh/presence.ts";

/** How long a question stands unanswered on screen before it parks. */
export const PARK_AFTER_MS = 5 * 60 * 1000;

/** How often a question on screen looks whether the person has gone. */
export const ABSENCE_EVERY_MS = 15 * 1000;

/** Why a question parked. */
export type ParkReason = "unanswered" | "locked" | "away";

/** Why the person can't answer now, as the shell says it. */
export type Absence = "locked" | "away";

/** Reads a marker's word, or nothing where there is no marker. */
export type ReadMarker = (path: string) => string | undefined;

/** The word in the file at `path`, or nothing when there is none. */
function readMarker(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		// No marker: the shell says nothing, so the person counts as there.
		return undefined;
	}
}

/**
 * Whether the shell says the person can't answer: the screen locked, or
 * away from it. Nothing when it says neither, or there's no runtime folder.
 */
export function absence(
	runtime: string | undefined,
	read: ReadMarker = readMarker,
): Absence | undefined {
	if (runtime === undefined) return undefined;
	if (read(join(runtime, "quickshell-locked")) === "locked") return "locked";
	if (read(join(runtime, "quickshell-away")) === "away") return "away";
	return undefined;
}

/** When a question on screen parks. */
export interface ParkWatch {
	readonly afterMs: number;
	readonly everyMs: number;
	/** Why the person can't answer now, looked at every `everyMs`. */
	readonly absent: () => Absence | undefined;
}

/**
 * Call `park` once, with why, when the question has stood `afterMs` or
 * the person turns absent. Answers what stops watching, which the caller
 * calls however the question ends.
 */
export function watchToPark(
	park: (reason: ParkReason) => void,
	watch: ParkWatch,
): () => void {
	let done = false;
	const stop = () => {
		done = true;
		clearTimeout(timeout);
		clearInterval(looking);
	};
	const parkFor = (reason: ParkReason) => {
		if (done) return;
		stop();
		park(reason);
	};
	const timeout = setTimeout(() => parkFor("unanswered"), watch.afterMs);
	const looking = setInterval(() => {
		const gone = watch.absent();
		if (gone) parkFor(gone);
	}, watch.everyMs);
	timeout.unref?.();
	looking.unref?.();
	return stop;
}

/** What a parked question carries to the look list. */
export interface ParkedQuestion {
	readonly prompt: string;
	readonly options: readonly { readonly label: string }[];
}

/** Why a parked question parked, in his words, for the look's why. */
const PARKED_BECAUSE: Record<ParkReason, string> = {
	unanswered:
		"It went unanswered for five minutes, so the session carried on without your answer.",
	locked:
		"Your screen was locked when it asked, so the session carried on without your answer.",
	away: "You were away from the screen when it asked, so the session carried on without your answer.",
};

/** The look's ask when the question's own words can't be its ask. */
const OPEN_TO_READ = "Open its window to read the question, then pick here.";

/** The look's ask when its choices can't be offered either. */
const OPEN_TO_ANSWER =
	"Open its window to read the question and answer it there.";

/**
 * What the look list is told of a parked question, opening its session's
 * window: the question's words and choices where a look can carry them,
 * and plainer words where it can't. Several questions park as one look,
 * answered in the window.
 */
export function parkedPointing(
	session: string,
	questions: readonly ParkedQuestion[],
	reason: ParkReason,
	answerable = true,
): Pointing {
	const base = {
		kind: "terminal" as const,
		target: session,
		why: PARKED_BECAUSE[reason],
		thread: "parked question",
	};
	const only = questions.length === 1 ? questions[0] : undefined;
	if (!only) {
		return {
			...base,
			title: `${questions.length} questions wait for you`,
			ask: OPEN_TO_ANSWER,
		};
	}
	const title = "A question waits for you";
	const choices = only.options.map((option) => option.label);
	const withChoices: Pointing[] = answerable
		? [
				{ ...base, title, ask: only.prompt, choices },
				{ ...base, title, ask: OPEN_TO_READ, choices },
			]
		: [];
	const tries: Pointing[] = [
		...withChoices,
		{ ...base, title, ask: only.prompt },
	];
	return (
		tries.find((one) => refusalOf(one) === undefined) ?? {
			...base,
			title,
			ask: OPEN_TO_ANSWER,
		}
	);
}

/** A parked question's look, or why none could be kept. */
export type Parked =
	| { readonly look: Look }
	| { readonly unkept: string; readonly look?: undefined };

/** Keep a parked question on the look list in `dir`. */
export function parkQuestions(
	dir: string,
	pointer: Pointer,
	questions: readonly ParkedQuestion[],
	reason: ParkReason,
	now: Date = new Date(),
): Parked {
	try {
		// The launcher sends a pick to the look's address, else its quest's;
		// with neither it has nowhere to send one, so the look offers no
		// choices and sends him to the window instead.
		const answerable = Boolean(pointer.address || pointer.quest);
		const pointing = parkedPointing(
			pointer.session,
			questions,
			reason,
			answerable,
		);
		return { look: pointAt(dir, pointing, pointer, now) };
	} catch (error) {
		return { unkept: error instanceof Error ? error.message : String(error) };
	}
}

/** Where a session's mesh presence and quest record are kept. */
export interface PointerRecords {
	/** The mesh's presence folder, one file a session. */
	readonly presences: string;
	/** The quest workflow's session records. */
	readonly sessions: string;
}

/**
 * The session parking a question, with the address it signs with on the
 * mesh and its loaded quest, where they are known: the launcher sends
 * the person's pick back to that address, else to the quest's session.
 */
export function pointerOf(session: string, records: PointerRecords): Pointer {
	const address = createPresences(records.presences).of(session)?.addresses[0];
	const quest = loadedQuest(session, records.sessions);
	return {
		session,
		...(address ? { address } : {}),
		...(quest ? { quest } : {}),
	};
}

/** Why it parked, as the asker reads it. */
const ASKER_REASON: Record<ParkReason, string> = {
	unanswered: "nobody answered it within five minutes",
	locked: "the person's screen is locked",
	away: "the person is away from the screen",
};

/** What the asker is told of a question it parked. */
export function parkedText(reason: ParkReason, parked: Parked): string {
	const lines = [`Parked, unanswered: ${ASKER_REASON[reason]}.`];
	if (parked.look) {
		const picks = parked.look.choices?.length
			? "with its choices; what they pick"
			: "opening this window; what they answer";
		lines.push(
			`It is on the person's look list, ${picks} arrives later as a message. A later question this session parks replaces it there.`,
		);
	} else {
		lines.push(
			`It could not be put on the person's look list (${parked.unkept}), so ask again later.`,
		);
	}
	lines.push(
		"Nothing was decided: take no recommendation and act on nothing as if answered. Carry on with what does not depend on it, and decide the rest from evidence where it is yours to decide.",
	);
	return lines.join("\n");
}
