/**
 * A line the person types during a run, until pi reads it.
 *
 * pi draws the line at once as a dim "Steering:" but reads it only once
 * the reply has streamed and every call in it has ended. So while it
 * waits, pi's working line says what it waits on, in plain words, and
 * calls that can move to the background hear of it (lib/jobs/steer.ts).
 * A line queued to follow the run, or one an extension sends, waits as
 * it was asked to and changes nothing here.
 *
 * Each line waits until pi reads it, never before, since another message
 * may be read first: the run's own prompt, or a steer from elsewhere.
 * pi queues a steered line as one user message, whose only text part is
 * the line once pi has expanded any skill or prompt template in it, and
 * whose images follow as parts of their own. pi matches its queue on a
 * message's text parts joined with nothing, so a line goes when those
 * are its own words, or the skill block pi expands it to. A line pi
 * reads in words that can't be matched, as a prompt template's, goes
 * once a read leaves pi holding nothing queued: pi drops a line from its
 * queue before it tells extensions it reads it. That lets go only a line
 * pi was seen holding something after it was typed, since pi queues a
 * line only once every extension has heard it. A line pi never reads
 * waits until the run ends instead: too long, never too short.
 */

import { isRecord } from "../../lib/internal/record.ts";
import { count, verb } from "../../lib/ui/count.ts";

/** A line typed during a run, and the calls it waits on. */
export interface TypedLine {
	/** The person typed `text`, a line pi holds until the turn's calls end. */
	typed(text: string): void;
	/** A call started. */
	started(toolCallId: string, toolName: string): void;
	/** A call ended, however it ended. */
	ended(toolCallId: string): void;
	/** pi says whether it holds messages queued to be read. */
	held(pending: boolean): void;
	/**
	 * pi read a user message of `content`, still holding messages queued
	 * after it when `pending`, letting go the line it read.
	 */
	read(content: unknown, pending: boolean): void;
	/** The run ended, so no line waits any more. */
	settled(): void;
	/** Whether a typed line waits to be read. */
	waiting(): boolean;
	/** What pi's working line says while the line waits; none once read. */
	words(): string | undefined;
}

/** A line that waits, and whether pi was seen holding a message since. */
interface Unread {
	readonly text: string;
	held: boolean;
}

/** Keep track of a typed line and the calls running beside it. */
export function typedLine(): TypedLine {
	let unread: Unread[] = [];
	const running = new Map<string, string>();
	const holdEach = () => {
		for (const line of unread) line.held = true;
	};
	return {
		typed(text) {
			unread.push({ text, held: false });
		},
		started(toolCallId, toolName) {
			running.set(toolCallId, toolName);
		},
		ended(toolCallId) {
			running.delete(toolCallId);
		},
		held(pending) {
			if (pending) holdEach();
		},
		read(content, pending) {
			const said = queuedTextOf(content);
			const at = unread.findIndex((line) => readsAs(line.text, said));
			if (at >= 0) unread.splice(at, 1);
			if (pending) holdEach();
			else unread = unread.filter((line) => !line.held);
		},
		settled() {
			unread = [];
		},
		waiting: () => unread.length > 0,
		words() {
			if (unread.length === 0) return undefined;
			return `Your message is read once ${waitedOn([...running.values()])}`;
		},
	};
}

/**
 * A user message's words as pi matches them against its queue: its text
 * parts joined with nothing, leaving out its images.
 */
function queuedTextOf(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content.map(textOfPart).join("");
}

/** A message part's text, or nothing for an image. */
function textOfPart(part: unknown): string {
	if (!isRecord(part) || part.type !== "text") return "";
	return typeof part.text === "string" ? part.text : "";
}

/** Whether pi reads a line typed as `typed` in the words `said`. */
function readsAs(typed: string, said: string | undefined): boolean {
	if (said === undefined) return false;
	return said === typed || readsAsSkill(typed, said);
}

/** What opens a line pi expands into a skill's text. */
const SKILL = "/skill:";

/**
 * Whether `said` is the block pi expands `/skill:name args` into: the
 * skill's text in `<skill name="name" location="...">` and `</skill>`,
 * then its arguments after a blank line when there are any. pi splits
 * the name off at the first space and trims the arguments.
 */
function readsAsSkill(typed: string, said: string): boolean {
	if (!typed.startsWith(SKILL)) return false;
	const space = typed.indexOf(" ");
	const name =
		space === -1 ? typed.slice(SKILL.length) : typed.slice(SKILL.length, space);
	const args = space === -1 ? "" : typed.slice(space + 1).trim();
	const opens = `<skill name="${name}" location="`;
	const ends = args ? `</skill>\n\n${args}` : "</skill>";
	return said.startsWith(opens) && said.endsWith(ends);
}

/** What a line waits on: the calls running, or the reply when none are. */
function waitedOn(names: readonly string[]): string {
	const [only] = names;
	if (only === undefined) return "this reply ends";
	if (names.length === 1) return `${only} ends`;
	return `${count(names.length, "call")} ${verb(names.length, "ends", "end")}`;
}
