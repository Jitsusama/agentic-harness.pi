/**
 * Talks followed: each steer that carries an id, from the moment this
 * session takes it to its reply, written to its talk file as it goes
 * (lib/mesh/talk.ts has the shape).
 *
 * A talk opens when its steer is delivered, and is taken when the
 * steer's message reaches the conversation: a busy session hands it to
 * pi to read after its current tool, and a run in its last turn can
 * end before pi does, so pi starts a new run for it. Only a taken talk
 * hears the run's steps and reply, and it closes when that run
 * settles: replied with the last text written since, or failed when
 * the run was stopped or wrote nothing. What concludes within
 * CAME_MS of the reply, before the next talk, is added as what came
 * of it; that is loose, since a conclusion in that hour need not be
 * the one the talk asked for.
 */

import type { Steer } from "../../lib/mesh/steer.ts";
import { pruneTalks, sayTalk, type TalkEvent } from "../../lib/mesh/talk.ts";

/** How often a talk says which step it is on, at most. */
export const READING_MS = 30_000;
/** How often a talk says its reply so far, at most. */
export const REPLYING_MS = 1_000;
/** How long after its reply a talk hears what came of it. */
export const CAME_MS = 60 * 60 * 1000;

/** What following talks needs from its session. */
export interface TalksHost {
	/** The session answering, as it stands when a talk opens. */
	readonly session: () => string;
	/** The clock, in milliseconds; the system's unless a test sets one. */
	readonly now?: () => number;
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
	/** Something came of the talks just answered, such as a plan concluded. */
	came(what: string, ref?: string): void;
}

interface Open {
	readonly inbox: string;
	readonly id: string;
	readonly since: number;
	/** The message it was delivered as, to know it when it is taken. */
	readonly message: string;
	taken: boolean;
	reply: string;
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
	const taken = () => open.filter((talk) => talk.taken);

	const say = (talk: Open, event: TalkEvent) => {
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
				reply: "",
			};
			open = [...open.filter((one) => one.id !== talk.id), talk];
			answered = [];
			say(talk, {
				stage: "delivered",
				session: host.session(),
				text: steer.text,
				...(steer.from ? { from: steer.from } : {}),
				...(steer.at ? { sentAt: steer.at } : {}),
			});
		},
		heard(text) {
			const said = text.trim();
			if (said === "") return;
			for (const talk of open) {
				if (!talk.taken && said.includes(talk.message)) talk.taken = true;
			}
		},
		step(step) {
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
			const moment = now();
			for (const talk of taken()) {
				if (
					talk.replying !== undefined &&
					moment - talk.replying < REPLYING_MS
				) {
					continue;
				}
				talk.replying = moment;
				say(talk, { stage: "replying", text });
			}
		},
		wrote(text) {
			if (text.trim() === "") return;
			for (const talk of taken()) talk.reply = text.trim();
		},
		settled(aborted) {
			const closing = taken();
			// A talk its run never took waits for the run pi starts for it.
			if (closing.length === 0) return;
			for (const talk of closing) {
				if (aborted) say(talk, { stage: "failed", why: "stopped" });
				else if (talk.reply) say(talk, { stage: "replied", text: talk.reply });
				else say(talk, { stage: "failed", why: "the run wrote no reply" });
			}
			const at = now();
			answered = closing.map((talk) => ({ talk, at }));
			open = open.filter((talk) => !talk.taken);
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
	};
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
