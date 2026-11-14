/**
 * Talks followed: each steer that carries an id, from the moment this
 * session takes it to its reply, written to its talk file as it goes
 * (lib/mesh/talk.ts has the shape).
 *
 * A talk opens when its steer is delivered, and is taken when the
 * steer's message reaches the conversation: a busy session hands it to
 * pi to read after its current tool, and a run in its last turn can
 * end before pi does, so pi starts a new run for it. Only a taken talk
 * hears the run's steps and reply. One taken into a run already
 * working closes at the first text written after it, since the person
 * asked to be answered first and what follows is the run's own work.
 * One that starts its run is replied by its first text too, at once,
 * and closes when that run settles: replied again with the last text
 * written since when the run went on past its first reply, or failed
 * when the run was stopped or wrote nothing. A reader takes a talk's
 * last reply. What concludes within
 * CAME_MS of the reply, before the next talk, is added as what came
 * of it; that is loose, since a conclusion in that hour need not be
 * the one the talk asked for.
 *
 * A replied talk is over once the session moves on from it: when a
 * newer talk to its address is replied, even after a reload or a
 * rollover, since the files say which are replied, or when the session
 * ends for good (endsForGood).
 * Its own work carrying on is not moving on, or the desktop's sign of
 * an unread answer would go as soon as it came.
 */

import type { Steer } from "../../lib/mesh/steer.ts";
import {
	overTalks,
	pruneTalks,
	sayTalk,
	type TalkEvent,
} from "../../lib/mesh/talk.ts";

/** How often a talk says which step it is on, at most. */
export const READING_MS = 30_000;
/** How often a talk says its reply so far, at most. */
export const REPLYING_MS = 1_000;
/** How long after its reply a talk hears what came of it. */
export const CAME_MS = 60 * 60 * 1000;

/** Why a replied talk is over once a newer one is replied. */
const NEWER = "a newer talk was answered";
/** Why a replied talk is over once its session ends for good. */
const ENDED = "the session ended";

/** What following talks needs from its session. */
export interface TalksHost {
	/** The session answering, as it stands when a talk opens. */
	readonly session: () => string;
	/** The clock, in milliseconds; the system's unless a test sets one. */
	readonly now?: () => number;
	/** The inboxes the session answers from, for its talks when it ends. */
	readonly inboxes?: () => readonly string[];
}

/** The talks one session follows. */
export interface Talks {
	/**
	 * A steer was delivered as this message: open its talk, when it
	 * carries an id.
	 */
	opened(steer: Steer, inbox: string, message: string): void;
	/** The person's message reached the conversation, with its text. */
	heard(text: string): void;
	/** The run began a step, such as a tool. */
	step(step: string): void;
	/** The reply as it stands while it is written. */
	writing(text: string): void;
	/** A message the session finished writing, with its text. */
	wrote(text: string): void;
	/** The run settled, stopped or not. */
	settled(aborted: boolean): void;
	/**
	 * Something came of the talks answered since the last one opened,
	 * within CAME_MS, such as a plan concluded: one answered early in a
	 * run and those its run's end closed alike.
	 */
	came(what: string, ref?: string): void;
	/** The session ended for good: its replied talks are over. */
	ended(): void;
}

interface Open {
	readonly inbox: string;
	readonly id: string;
	readonly since: number;
	/** The message it was delivered as, to know it when it is taken. */
	readonly message: string;
	taken: boolean;
	/** Taken into a run already working, so its first text replies. */
	intoWork: boolean;
	reply: string;
	/** The last stage said of it, and the last reply, so none is said twice. */
	last?: TalkEvent["stage"];
	replied?: string;
	/** The reply so far last said, so the same text is said once. */
	said?: string;
	reading?: number;
	replying?: number;
}

interface Answered {
	readonly talk: Open;
	readonly at: number;
}

/** Following talks, starting with none. */
export function createTalks(host: TalksHost): Talks {
	const now = host.now ?? Date.now;
	let open: Open[] = [];
	let answered: Answered[] = [];
	/** Whether the run under way has stepped or written yet. */
	let working = false;
	const taken = () => open.filter((talk) => talk.taken);

	/** The inboxes talks were delivered from, here or before a reload. */
	const inboxes = new Set<string>();

	const close = (closing: readonly Open[]) => {
		const at = now();
		answered = [...answered, ...closing.map((talk) => ({ talk, at }))];
		open = open.filter((talk) => !closing.includes(talk));
	};

	/** Reply to a talk, which ends the talks its session replied before. */
	const reply = (talk: Open, text: string) => {
		say(talk, { stage: "replied", text });
		try {
			overTalks(talk.inbox, NEWER, talk.id, new Date(now()));
		} catch {
			// An earlier talk left as replied is the desktop's sign kept a while
			// longer; the next reply or the session's end tries again.
		}
	};

	/**
	 * Close the talks a run already answered as they stand, since what it
	 * writes once a newer talk is taken answers that one.
	 */
	const settleAnswered = (talks: readonly Open[]) => {
		const answeredHere = talks.filter((talk) => talk.reply);
		for (const talk of answeredHere) {
			if (talk.last !== "replied" || talk.replied !== talk.reply) {
				reply(talk, talk.reply);
			}
		}
		close(answeredHere);
	};

	const say = (talk: Open, event: TalkEvent) => {
		talk.last = event.stage;
		if (event.stage === "replied") talk.replied = event.text;
		try {
			sayTalk(talk.inbox, talk.id, event, new Date(now()));
		} catch {
			// A talk that can't be written is the desktop's to miss; the
			// session answers all the same.
		}
	};

	return {
		opened(steer, inbox, message) {
			if (!steer.id) return;
			try {
				pruneTalks(inbox, now());
			} catch {
				// Pruning waits for the next talk opened here.
			}
			const talk: Open = {
				inbox,
				id: steer.id,
				since: now(),
				message: message.trim(),
				taken: false,
				intoWork: false,
				reply: "",
			};
			open = [...open.filter((one) => one.id !== talk.id), talk];
			answered = [];
			inboxes.add(inbox);
			say(talk, {
				stage: "delivered",
				session: host.session(),
				text: steer.text,
				...(steer.from ? { from: steer.from } : {}),
				...(steer.at ? { sentAt: steer.at } : {}),
				...(steer.re ? { re: steer.re } : {}),
			});
		},
		heard(text) {
			const said = text.trim();
			if (said === "") return;
			const before = taken();
			let came = false;
			for (const talk of open) {
				if (talk.taken || !said.includes(talk.message)) continue;
				talk.taken = true;
				talk.intoWork = working;
				came = true;
			}
			if (came) settleAnswered(before);
		},
		step(step) {
			working = true;
			const moment = now();
			for (const talk of taken()) {
				if (talk.reading !== undefined && moment - talk.reading < READING_MS) {
					continue;
				}
				talk.reading = moment;
				say(talk, {
					stage: "reading",
					after: `${step}, ${howLong(moment - talk.since)}`,
				});
			}
		},
		writing(text) {
			if (text.trim() === "") return;
			working = true;
			const moment = now();
			for (const talk of taken()) {
				if (
					talk.said === text ||
					(talk.replying !== undefined && moment - talk.replying < REPLYING_MS)
				) {
					continue;
				}
				talk.replying = moment;
				talk.said = text;
				say(talk, { stage: "replying", text });
			}
		},
		wrote(text) {
			const said = text.trim();
			if (said === "") return;
			working = true;
			const first = taken().filter((talk) => talk.intoWork);
			for (const talk of first) reply(talk, said);
			if (first.length > 0) close(first);
			for (const talk of taken()) {
				if (!talk.reply) reply(talk, said);
				talk.reply = said;
			}
		},
		settled(aborted) {
			working = false;
			const closing = taken();
			// A talk its run never took waits for the run pi starts for it.
			if (closing.length === 0) return;
			for (const talk of closing) {
				if (aborted) say(talk, { stage: "failed", why: "stopped" });
				else if (talk.reply) {
					if (talk.last !== "replied" || talk.replied !== talk.reply) {
						reply(talk, talk.reply);
					}
				} else say(talk, { stage: "failed", why: "the run wrote no reply" });
			}
			close(closing);
		},
		came(what, ref) {
			const moment = now();
			const recent = answered
				.filter(({ at }) => moment - at < CAME_MS)
				.map(({ talk }) => talk);
			for (const talk of [...taken(), ...recent]) {
				say(talk, { stage: "came", what, ...(ref ? { ref } : {}) });
			}
		},
		ended() {
			const at = new Date(now());
			for (const inbox of new Set([...inboxes, ...(host.inboxes?.() ?? [])])) {
				try {
					overTalks(inbox, ENDED, undefined, at);
				} catch {
					// An inbox that can't be read keeps its sign; nothing here can
					// try again, and the launcher still reads the talk as replied.
				}
			}
		},
	};
}

/** What else is happening to a session as it shuts down. */
export interface ShuttingDown {
	/** It parked, for its holder to wake. */
	readonly parked: boolean;
	/** Its holder starts it again at once, as a restart in place does. */
	readonly restarting: boolean;
}

/**
 * Whether a shutdown ends the session for good: pi quitting, with no
 * park or restart in place to bring it back. A reload, and a rollover
 * (`new` or `resume`, which carries the conversation on in a fresh
 * log), don't.
 */
export function endsForGood(event: unknown, how: ShuttingDown): boolean {
	const quit =
		typeof event === "object" &&
		event !== null &&
		"reason" in event &&
		event.reason === "quit";
	return quit && !how.parked && !how.restarting;
}

/** The text a message carries, when it is the assistant's. */
export function assistantText(message: unknown): string {
	return textAs(message, "assistant");
}

/** The text a message carries, when it is the person's. */
export function userText(message: unknown): string {
	return textAs(message, "user");
}

function textAs(message: unknown, role: string): string {
	if (typeof message !== "object" || message === null) return "";
	if (!("role" in message) || message.role !== role) return "";
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) =>
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? part.text
				: "",
		)
		.join("");
}

const KINDS: Record<string, string> = {
	QEST: "quest",
	PLAN: "plan",
	RSCH: "research",
	BRIF: "brief",
	RPRT: "report",
};

/** What ending a quest or document reads as in a talk: "plan concluded". */
export function ended(id: string, how: string): string {
	const kind = KINDS[id.split("-")[0] ?? ""];
	return kind ? `${kind} ${how}` : how;
}

/** How long, as the desktop says it: seconds under a minute, then minutes. */
function howLong(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}
