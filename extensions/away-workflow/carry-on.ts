/**
 * Whether a session the person is at, but not answering, should carry
 * on with its plan.
 *
 * Away mode covers the person who said they were leaving. This covers
 * the one who did not: a run ends with a plan in build still open,
 * and nobody types. Before this, the session sat there until the
 * person came back and said "keep going", which they did about 150
 * times between 12 and 21 October 2026. Now, after a quiet stretch, the session takes the
 * plan's next item. When its run ended by asking the person something,
 * the question stands, the person is reached at the desktop once, and
 * the session carries on with what does not need the answer.
 *
 * The gate is a plan in build, since that is the person's agreement to
 * implement, and a run that was working (it made tool calls) when it
 * stopped short. A reply that only talked, such as "holding" after the
 * person said to wait, is never carried on, and the carry-on itself
 * tells the model to rest if the person asked it to stop. A run that
 * ended `Done:` or `Blocked:` rests. The bound is away mode's: fifty
 * carry-ons in one quiet stretch. Anything the person types starts the
 * count again.
 */

import type { PlanProgress } from "../../lib/internal/away/state.ts";
import type { Notice } from "../../lib/internal/notify.ts";
import { endingOf, MAX_NUDGES, type RunSummary } from "./keep-going.ts";

/**
 * How long a run's end goes unanswered before the session carries on.
 *
 * Long enough to read what the run said and reply, short enough that a
 * person who stepped away comes back to work done rather than waiting.
 */
export const QUIET_MS = 10 * 60_000;

/** What carrying on remembers within one quiet stretch. */
export interface CarryOnMemory {
	/** Carry-ons sent since the person last typed. */
	carried: number;
	/** Whether the person was reached about a question this stretch. */
	askedSaid: boolean;
}

/** Nothing carried on yet: the person has just typed. */
export function freshCarryOn(): CarryOnMemory {
	return { carried: 0, askedSaid: false };
}

/** Whether a reply ends by asking the person something. */
export function endsAsking(text: string): boolean {
	const last = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
	return last?.endsWith("?") ?? false;
}

/**
 * Whether to wait out a quiet stretch after this run, and carry on at
 * its end.
 */
export function shouldWait(
	run: RunSummary,
	progress: PlanProgress | undefined,
	memory: CarryOnMemory,
): boolean {
	if (!progress || progress.total - progress.done <= 0) return false;
	if (run.aborted || run.toolCalls === 0) return false;
	if (endingOf(run.lastText)) return false;
	return memory.carried < MAX_NUDGES;
}

/** What the session is told when the quiet stretch ends. */
export function carryOnText(
	progress: PlanProgress,
	asked: boolean,
	minutes = QUIET_MS / 60_000,
): string {
	const open = progress.total - progress.done;
	const next = progress.next ? ` Next: ${progress.next}` : "";
	return [
		`Nobody has answered for ${minutes} minutes, and ${progress.document} has ${open} open ${open === 1 ? "item" : "items"}.${next}`,
		asked
			? "Your question stands for the user, who has been reached at their desktop. Carry on with what does not need the answer, and make reversible choices yourself, saying what you chose."
			: "Carry on with it. Make reversible choices yourself and say what you chose.",
		"If the user asked you to stop or wait, do nothing and end with a last line starting `Blocked:` that says so. When nothing within your reach is left, end with `Done:` or `Blocked:`, naming what needs the user.",
	].join("\n");
}

/**
 * The desktop notice for a question left unanswered, once a stretch.
 * Normal urgency: the session is not stuck, but the person's answer
 * would unblock part of it.
 */
export function askedNotice(
	where: string,
	lastText: string,
	memory: CarryOnMemory,
): Notice | undefined {
	if (memory.askedSaid) return undefined;
	memory.askedSaid = true;
	const question = lastText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
	return {
		title: `${where} asked you something`,
		body: `${(question ?? "").slice(0, 240)} It carries on with the rest meanwhile.`,
		urgency: "normal",
	};
}
