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
 * So a short reply that names a job or a wait, while a job runs, is a
 * bare wait, and is sent back once, naming the jobs running and asking
 * for those four things. The run that answers is never sent back, so a
 * model that answers bare again rests, and the bare run's tool calls
 * count in its answer's, for away mode and carrying on to judge the two
 * as the one run they are. A run that asks the person something, or
 * that they stopped, is theirs, and is left alone.
 */

import type { RunningJob } from "../../lib/jobs/index.ts";
import { endsAsking } from "./carry-on.ts";
import { combine, type RunSummary } from "./keep-going.ts";

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
const JOB_ID = /\bj\d+\b/i;

/** Words a reply waiting on background work says it with. */
const WAIT_WORDS =
	/\b(?:jobs?|wait(?:s|ing)?|reports?|running|comes? back|lands?|finish(?:es)?)\b/i;

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

/** Whether a run ended only saying it waits on a job that is running. */
export function isBareWait(
	run: RunSummary,
	running: readonly RunningJob[],
): boolean {
	if (running.length === 0 || run.aborted) return false;
	const text = run.lastText.trim();
	if (text.length === 0 || endsAsking(text)) return false;
	const words = wordsOf(text);
	if (words.length > MAX_BARE_WORDS) return false;
	const said = words.join(" ");
	return JOB_ID.test(said) || WAIT_WORDS.test(said);
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
): JobWaitVerdict {
	const { sentBack } = memory;
	if (sentBack) {
		memory.sentBack = undefined;
		return { kind: "go-on", run: combine(sentBack, run) };
	}
	if (!isBareWait(run, running)) return { kind: "go-on", run };
	memory.sentBack = run;
	return { kind: "send-back", text: jobWaitText(running) };
}
