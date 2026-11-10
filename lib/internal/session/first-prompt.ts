/**
 * Whether pi's own first prompt, the message its command line gave it,
 * has yet to become a run. pi submits it once every extension has
 * started, and refuses it ("Agent is already processing") if a turn is
 * under way by then, so a turn the harness starts in that moment takes
 * its place and the words are lost. On 11-02 at 18:41 a session Reopen
 * Them All started with its carry-on words lost them to the job host's
 * cut-off notice (Y2YBTS [6508f771]). Whatever would start a turn on
 * its own asks this first, and waits or says its piece without a turn.
 *
 * Plain pi reads its command line and process uptime, keeping the slot
 * across reloads. A host admits each conversation's initial words before
 * extension loading and measures from that admission, not host uptime.
 * A first prompt pi refused, or one an extension command took, never
 * becomes a run, so the wait is bounded in both modes.
 */

import { parseArgs } from "@earendil-works/pi-coding-agent";
import { hosted } from "../../core/session/index.ts";
import { firstPromptSlot as slot } from "./first-prompt-slot.ts";

export { noteFirstPrompt } from "./first-prompt-slot.ts";

/**
 * How long after the process starts its first prompt may still be on
 * its way. Under load after a boot, 35 reopened sessions took 3 to 7 s
 * from their first log entry to their first prompt (11-02, 18:40).
 */
export const FIRST_PROMPT_MS = 60_000;

/** Whether these command-line words give pi a first prompt. */
export function givesFirstPrompt(args: readonly string[]): boolean {
	try {
		return parseArgs([...args]).messages.length > 0;
	} catch {
		// Words pi's parser can't read: pi refuses them itself, with no prompt.
		return false;
	}
}

/** Whether the conversation's first prompt is still to become a run. */
export function firstPromptPending(
	args: readonly string[] = process.argv.slice(2),
	upMs: number = process.uptime() * 1000,
): boolean {
	const current = slot();
	if (current.ran) return false;
	if (hosted()) {
		return (
			current.hasInitialWords === true &&
			current.beganAt !== undefined &&
			Date.now() - current.beganAt < FIRST_PROMPT_MS
		);
	}
	return upMs < FIRST_PROMPT_MS && givesFirstPrompt(args);
}

/** A run started: whatever prompt was first has had its turn. */
export function runStarted(): void {
	slot().ran = true;
}
