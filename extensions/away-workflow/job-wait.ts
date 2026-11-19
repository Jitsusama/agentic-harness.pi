/**
 * Whether a run that ended while background work runs said where
 * things stand, and what to ask of it when it did not.
 *
 * A turn that ends while a job runs is what the person reads until the
 * job reports, which can be an hour. From 18 to 19 November one session
 * ended turns with "Waiting on the eval tests (j27)." and "Waiting on
 * j30 (the zone's Go tests) before committing; it reports on its own.",
 * which say nothing the person can act on: not what the job is, how far
 * it has got, when it reports or what follows. The same session's
 * endings that said where things stood ran 33 words and more; the bare
 * ones ran 6 to 23.
 *
 * So a short reply that says it waits on work, gives no figure or time
 * for how far it has got or when it reports, and names no job but one
 * still running, is a bare wait while a job runs, and is sent back once, naming the jobs running and asking
 * for those four things. The run that answers is never sent back, so a
 * model that answers bare again rests, and the bare run's tool calls
 * count in its answer's, for away mode and carrying on to judge the two
 * as the one run they are. A run that asks the person something, or
 * that they stopped, is theirs, and is left alone. While they are away,
 * a `Done:` or `Blocked:` ending is away mode's to judge, since nobody
 * reads it until they are back and keep-going already rests it on the
 * job that will wake it.
 */

import type { RunningJob } from "../../lib/jobs/index.ts";
import { combine, endingOf, type RunSummary } from "./keep-going.ts";

/**
 * The most words a bare wait runs to. KAN5HP's bare endings ran 6 to 23
 * words, and its endings that said where things stood 33 and more.
 */
export const MAX_BARE_WORDS = 30;

/** What the check remembers between runs. */
export interface JobWaitMemory {
	/** The bare run sent back, while the run answering it is under way. */
	sentBack: RunSummary | undefined;
}

/** Nothing sent back yet. */
export function freshJobWait(): JobWaitMemory {
	return { sentBack: undefined };
}

/** What follows a run's end. */
export type JobWaitVerdict =
	| { readonly kind: "send-back"; readonly text: string }
	| { readonly kind: "go-on"; readonly run: RunSummary };

/** A job's id, as the job list and its reports name it. */
const JOB_ID = /\bj\d+\b/gi;

/**
 * How a reply says it waits on work, in the verb's sense: never a noun
 * such as a report or a job, and never a wait on the person.
 */
const WAITS =
	/\b(?:wait(?:s|ing)? (?:on|for) (?!(?:you|your|the user)\b)|(?:reports?|comes? back|lands?|finish(?:es)?) on (?:its|their) own|once (?:it|they) (?:lands?|reports?|finish(?:es)?|do(?:es)?)\b)/i;

/**
 * A figure or a span of time, which says how far work has got or when
 * it reports: a number standing alone (8, 8 of 13, 60%, ~20) or a unit.
 */
const STANDING =
	/(?:^|[\s(~])\d+(?:[.,]\d+)?%?(?=$|[\s.,;:)])|\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i;

/** How a run says it ended, which is no part of what it says. */
const ENDING_LEAD = /^(?:done|blocked):/i;

/** Markdown a model dresses a reply in. */
const DRESSING = /[*_`#>]/g;

/** The words a reply says, with its markdown and any ending's lead taken off. */
function wordsOf(text: string): string[] {
	return text
		.split("\n")
		.map((line) =>
			line
				.replace(DRESSING, "")
				.replace(/^\s*[-+]\s+/, "")
				.trim()
				.replace(ENDING_LEAD, ""),
		)
		.join(" ")
		.split(/\s+/)
		.filter((word) => /[\p{L}\p{N}]/u.test(word));
}

/**
 * Whether a run ended only saying it waits on work, while a job runs.
 * `away` when the person is away, which leaves a `Done:` or `Blocked:`
 * ending to away mode.
 */
export function isBareWait(
	run: RunSummary,
	running: readonly RunningJob[],
	away = false,
): boolean {
	if (running.length === 0 || run.aborted) return false;
	const text = run.lastText.trim();
	if (text.length === 0) return false;
	if (away && endingOf(text)) return false;
	const words = wordsOf(text);
	const said = words.join(" ");
	if (said.endsWith("?")) return false;
	if (words.length > MAX_BARE_WORDS) return false;
	// A figure counts only beside the wait: one about other work is no
	// word on this one.
	const waits = said.split(/(?<=[.!])\s+/).filter((part) => WAITS.test(part));
	if (waits.length === 0) return false;
	const named = waits.join(" ").replace(JOB_ID, " ").replace(/#\d+/g, " ");
	if (STANDING.test(named)) return false;
	const ids = new Set(running.map((job) => job.id.toLowerCase()));
	return [...said.matchAll(JOB_ID)].every(([id]) => ids.has(id.toLowerCase()));
}

/** What a bare wait is sent back with. */
export function jobWaitText(running: readonly RunningJob[]): string {
	const named = running.map((job) => `${job.id} (${job.label})`).join("; ");
	return [
		`Your last reply only said you are waiting on background work, which tells the person reading it little until it reports. Running now: ${named}.`,
		"In a few lines, tell the person where things stand, what each is doing, when it reports, and what you will do once it has. Each reports on its own and starts a turn, so do not wait on it in this run.",
		"If your last reply ended with a `Done:` or `Blocked:` line, end with it again.",
	].join("\n");
}

/**
 * Decide what follows a run's end, given the jobs still running. Updates
 * `memory`.
 */
export function afterJobWait(
	run: RunSummary,
	running: readonly RunningJob[],
	memory: JobWaitMemory,
	away = false,
): JobWaitVerdict {
	const { sentBack } = memory;
	if (sentBack) {
		memory.sentBack = undefined;
		return { kind: "go-on", run: combine(sentBack, run) };
	}
	if (!isBareWait(run, running, away)) return { kind: "go-on", run };
	memory.sentBack = run;
	return { kind: "send-back", text: jobWaitText(running) };
}
