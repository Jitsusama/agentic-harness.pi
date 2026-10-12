/**
 * Whether an unattended run has really finished, and what to tell it
 * when it has not.
 *
 * Once the person has said they are away, a run may end in two ways
 * only: its last line starts `Done:` (the goal is met) or `Blocked:`
 * (everything left needs the person). Any other ending (a summary, a
 * question, an error) is answered with the goal again.
 *
 * The bounds are what stop this becoming a machine that spends all
 * night. A run that makes no tool calls at all is idle, and three idle
 * runs in a row stop the nudging; so do fifty nudges in one absence,
 * however busy the runs. A stop is said, not silent, so the person can
 * see in the morning why the work rested.
 */

import type { PlanProgress } from "../../lib/internal/away/state.ts";

/** Idle runs in a row before the nudging stops. */
export const MAX_IDLE_RUNS = 3;

/** Nudges in one absence before the nudging stops regardless. */
export const MAX_NUDGES = 50;

/** What one run, from prompt to settling, did. */
export interface RunSummary {
	/** The text of the last assistant message. */
	readonly lastText: string;
	/** Tool calls made across the run. */
	readonly toolCalls: number;
	/** Whether its last assistant message was stopped by the person. */
	readonly aborted: boolean;
}

/** The absence the decision is made in. */
export interface Absence {
	readonly since: string;
	readonly goal?: string;
	readonly held: number;
	readonly progress?: PlanProgress;
}

/** What the nudger remembers between runs of one absence. */
export interface KeepGoingMemory {
	absence?: string;
	idleRuns: number;
	nudges: number;
	/** The plan a premature `Done:` was already sent back for. */
	doneChallenged?: string;
	/** Set once the nudging has stopped for this absence. */
	stopped: boolean;
}

/** What to do at the end of a run. */
export type Verdict =
	| { readonly kind: "nudge"; readonly text: string }
	| { readonly kind: "rest"; readonly why: "done" | "blocked" }
	| { readonly kind: "stop"; readonly note: string }
	| { readonly kind: "quiet" };

/** A nudger that has seen nothing yet. */
export function freshMemory(): KeepGoingMemory {
	return { idleRuns: 0, nudges: 0, stopped: false };
}

/** Markdown a model dresses a line in: a bullet, a quote, bold. */
const DRESSING = /^(?:[-*>]\s+)*(?:\*\*|__)?/;

/** How the run said it ended, read from its last non-empty line. */
export function endingOf(text: string): "done" | "blocked" | undefined {
	const lines = text.split("\n").map((line) => line.trim());
	const last = lines.filter((line) => line.length > 0).at(-1);
	if (!last) return undefined;
	const bare = last.replace(DRESSING, "");
	if (/^done:/i.test(bare)) return "done";
	if (/^blocked:/i.test(bare)) return "blocked";
	return undefined;
}

function goalLine(absence: Absence): string {
	return absence.goal
		? `The user is away and asked you to keep working until this is done: ${absence.goal}`
		: "The user is away and asked you to keep working.";
}

function progressLine(progress: PlanProgress | undefined): string {
	if (!progress) return "";
	const next = progress.next ? ` Next: ${progress.next}` : "";
	return `${progress.document}: ${progress.done} of ${progress.total} items done.${next}`;
}

function heldLine(held: number): string {
	if (held === 0) return "";
	return `${held} ${held === 1 ? "call is" : "calls are"} held for their return; carry on with work that does not need ${held === 1 ? "it" : "them"}.`;
}

const RULE =
	"If a choice is reversible, make it and say what you chose. End a run only with a last line starting `Done:` when the goal is met, or `Blocked:` naming what needs the user when nothing within your reach is left.";

/**
 * Decide what follows a run that settled while the person is away.
 * Updates `memory`.
 */
export function afterRun(
	run: RunSummary,
	absence: Absence,
	memory: KeepGoingMemory,
): Verdict {
	if (memory.absence !== absence.since) {
		Object.assign(memory, freshMemory(), { absence: absence.since });
	}
	if (memory.stopped) return { kind: "quiet" };

	memory.idleRuns = run.toolCalls === 0 ? memory.idleRuns + 1 : 0;
	const ending = endingOf(run.lastText);
	if (ending === "blocked") return { kind: "rest", why: "blocked" };

	const { progress } = absence;
	const open = progress ? progress.total - progress.done : 0;
	if (ending === "done") {
		if (!progress || open <= 0 || memory.doneChallenged === progress.document)
			return { kind: "rest", why: "done" };
		memory.doneChallenged = progress.document;
	}

	if (memory.idleRuns >= MAX_IDLE_RUNS) {
		memory.stopped = true;
		return {
			kind: "stop",
			note: `Away mode stopped sending the run back to work: its last ${MAX_IDLE_RUNS} runs made no tool calls. Calls held so far stay held for the user.`,
		};
	}
	if (memory.nudges >= MAX_NUDGES) {
		memory.stopped = true;
		return {
			kind: "stop",
			note: `Away mode stopped sending the run back to work after ${MAX_NUDGES} nudges in this absence. Calls held so far stay held for the user.`,
		};
	}
	memory.nudges += 1;

	const opening =
		ending === "done" && progress
			? `You ended with Done:, but ${progress.document} still has ${open} open ${open === 1 ? "item" : "items"}. Finish them, or say why they are out of scope, then end with Done: again.`
			: "Your last reply did not end with a `Done:` or `Blocked:` line, so the run is not over. Carry on.";
	const lastChance =
		memory.idleRuns === MAX_IDLE_RUNS - 1
			? "Your last runs made no tool calls; one more and away mode stops sending you back until the user returns."
			: "";
	return {
		kind: "nudge",
		text: [
			goalLine(absence),
			progressLine(progress),
			heldLine(absence.held),
			opening,
			RULE,
			lastChance,
		]
			.filter(Boolean)
			.join("\n"),
	};
}

/** What a run did, read from the messages pi hands `agent_end`. */
export function summarize(messages: readonly unknown[]): RunSummary {
	let lastText = "";
	let toolCalls = 0;
	let aborted = false;
	for (const message of messages) {
		if (
			typeof message !== "object" ||
			message === null ||
			!("role" in message) ||
			message.role !== "assistant" ||
			!("content" in message) ||
			!Array.isArray(message.content)
		)
			continue;
		const texts: string[] = [];
		for (const part of message.content) {
			if (typeof part !== "object" || part === null || !("type" in part))
				continue;
			if (part.type === "toolCall") toolCalls += 1;
			if (
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			)
				texts.push(part.text);
		}
		lastText = texts.join("\n");
		aborted = "stopReason" in message && message.stopReason === "aborted";
	}
	return { lastText, toolCalls, aborted };
}

/** Two runs' worth, as one: a run can end more than once before it settles. */
export function combine(earlier: RunSummary, later: RunSummary): RunSummary {
	return {
		lastText: later.lastText,
		toolCalls: earlier.toolCalls + later.toolCalls,
		aborted: later.aborted,
	};
}
