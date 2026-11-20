/**
 * The wait between a run that ended on a passing model failure and
 * the next try: when it starts, what the person sees while it runs,
 * what ends it early, and how a fresh load takes it up. A call the
 * person's own key was refused for, over its cap, waits for nothing:
 * once the session's budget keeper moves it onto the budget named for
 * that, it is tried at once (lib/budget/capped.ts).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { askBudgetWhenCapped, isCapRefusal } from "../../lib/budget/capped.ts";
import {
	FIRST_WAIT_MS,
	failedForAMoment,
	failureLine,
	MOST_BILLED_TRIES,
	waitBefore,
	wasBilled,
} from "../../lib/internal/errors/model-failure.ts";
import { whileCurrent } from "../../lib/internal/errors/stale.ts";
import { findJobHost, type Job } from "../../lib/jobs/index.ts";
import { footerMark } from "../../lib/ui/footer-mark.ts";
import {
	RETRY_ENTRY,
	type RetryMark,
	TRY_LABEL,
	unfinishedWait,
} from "./record.ts";

/** The footer key the waiting mark is written under. */
const STATUS_KEY = "model-retry";

/** The kind of job a try is said through. */
const JOB_KIND = "model-retry";

const MS_PER_SECOND = 1000;

/** The retry state of one session, and what moves it. */
export interface Retrier {
	/** A load started: take up a wait the last one left, if any. */
	resumed(ctx: ExtensionContext): void;
	/** A run ended: its last reply, when it had one. */
	ended(reply: AssistantMessage | undefined): void;
	/** The run settled: wait and try again, or let it rest. */
	settled(aborted: boolean, ctx: ExtensionContext): void;
	/** Another run started, so its own settling decides. */
	started(): void;
	/** The person typed: whatever came before is theirs to judge. */
	typed(): void;
	/** A dialog or panel opened (true) or closed (false). */
	prompting(open: boolean): void;
	/** The session is going away. */
	stop(): void;
}

/** A retrier sending its tries through `pi`. */
export function createRetrier(pi: ExtensionAPI): Retrier {
	let last: AssistantMessage | undefined;
	let tries = 0;
	// How many of the streak's failures were billed, which caps its tries.
	let billed = 0;
	const countAfresh = () => {
		tries = 0;
		billed = 0;
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let shown: ExtensionContext | undefined;
	let unlisten: (() => void) | undefined;
	let unsaid: Job | undefined;
	// An Escape while a dialog or panel is open closes it, not the wait.
	let prompts = false;
	// Bumped whenever the wait is stopped, so a budget laid for a capped
	// key after the person or another run took over tries nothing.
	let movingOn = 0;
	// Whether the session moved off a capped key since a turn last ended
	// well, so a second refusal for the cap doesn't ask to move again.
	let movedOffCap = false;

	// The mark goes in the session's branch, so the load after a reload or
	// a restart knows what this one was waiting on (record.ts).
	const mark = whileCurrent((said: RetryMark) => {
		pi.appendEntry(RETRY_ENTRY, said);
	});

	const stopWaiting = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		unlisten?.();
		unlisten = undefined;
		if (shown) whileCurrent(clearMark)(shown);
		shown = undefined;
		// A try not yet said would start a run on top of one already going.
		unsaid?.withdraw();
		unsaid = undefined;
		movingOn++;
	};

	/** Stop the count for good: the person has it now. */
	const handBack = () => {
		const counting = tries > 0 || timer !== undefined;
		stopWaiting();
		countAfresh();
		if (counting) mark({ attempt: 0 });
	};

	// The try is said through job-workflow, the one thing that starts a
	// turn nobody typed, at a moment no run or prompt is under way.
	const tryAgain = (ctx: ExtensionContext, attempt: number, line: string) =>
		sayTry(ctx, retryText(attempt, line));

	const sayTry = (ctx: ExtensionContext, summary: string) => {
		timer = undefined;
		unlisten?.();
		unlisten = undefined;
		clearMark(ctx);
		shown = undefined;
		const host = findJobHost(pi.events);
		if (!host) {
			ctx.ui.notify(
				"The model call cannot be tried again: job-workflow is not loaded.",
				"warning",
			);
			return;
		}
		const job = host.start({ kind: JOB_KIND, label: TRY_LABEL });
		unsaid = job;
		job.onDelivered(() => {
			if (unsaid === job) unsaid = undefined;
		});
		job.finish({ summary });
	};

	/**
	 * Ask for the budget named for a capped key and, once it is laid,
	 * try at once; with none, the turn ends as any usage limit's does.
	 */
	const moveOffCap = (ctx: ExtensionContext, reply: AssistantMessage) => {
		const line = failureLine(reply);
		// Refused for the cap again before any turn ended well: the move
		// didn't help, so it isn't asked for again until one does, whatever
		// the keeper would answer.
		if (movedOffCap) {
			ctx.ui.notify(
				`The model call was refused for the cap again after moving to a budget: ${line}. Type to try again.`,
				"warning",
			);
			return;
		}
		const asked = movingOn;
		askBudgetWhenCapped(pi.events, line).then(
			whileCurrent((drawn: string | null) => {
				if (drawn === null || asked !== movingOn) return;
				movedOffCap = true;
				sayTry(ctx, cappedText(drawn, line));
			}),
		);
	};

	/** Wait `delay` before try `attempt`, saying so in the window. */
	const wait = (
		ctx: ExtensionContext,
		attempt: number,
		delay: number,
		reply: AssistantMessage,
	) => {
		const line = failureLine(reply);
		tries = attempt;
		shown = ctx;
		ctx.ui.setStatus(
			STATUS_KEY,
			footerMark("retrying", "warning", ctx.ui.theme, attempt),
		);
		// pi's Escape stops a run, and while this waits there is none, so
		// the wait hears the key itself, where the window lets it: a host
		// may give a UI with no raw keys, whatever pi's types say.
		const hears = typeof ctx.ui.onTerminalInput === "function";
		if (hears) {
			unlisten = ctx.ui.onTerminalInput((data) => {
				if (prompts || isKeyRelease(data)) return undefined;
				if (matchesKey(data, Key.escape)) whileCurrent(escaped)(ctx);
				return undefined;
			});
		}
		const stopWith = hears ? "Press Escape or type to stop." : "Type to stop.";
		ctx.ui.notify(
			`The model call failed: ${line}. Trying again in ${Math.round(delay / MS_PER_SECOND)} s (try ${attempt}). ${stopWith}`,
			"warning",
		);
		timer = setTimeout(
			whileCurrent(() => tryAgain(ctx, attempt, line)),
			delay,
		);
		timer.unref?.();
	};

	const escaped = (ctx: ExtensionContext) => {
		handBack();
		ctx.ui.notify(
			"Stopped trying the model call again. Type to carry on.",
			"info",
		);
	};

	return {
		resumed(ctx) {
			stopWaiting();
			countAfresh();
			// A run under way settles on its own, and its settling decides.
			if (!ctx.isIdle()) return;
			const now = Date.now();
			const left = unfinishedWait(
				ctx.sessionManager.getBranch(),
				ctx.model?.contextWindow ?? 0,
				now,
			);
			if (!left) return;
			billed = left.billed;
			// A try the last load kept unsaid as its host restarted is said by
			// job-workflow in this one; the count goes on from it.
			if (left.carried) {
				tries = left.attempt;
				return;
			}
			// Never sooner than the first wait, so the person sees the notice
			// and can stop it before a try left overdue goes out.
			const delay = Math.max(left.due - now, FIRST_WAIT_MS);
			mark({ attempt: left.attempt, due: now + delay });
			wait(ctx, left.attempt, delay, left.reply);
		},
		ended(reply) {
			if (reply) last = reply;
		},
		settled(aborted, ctx) {
			const reply = last;
			last = undefined;
			stopWaiting();
			const failed =
				reply !== undefined &&
				failedForAMoment(reply, ctx.model?.contextWindow ?? 0);
			// Escape on a run, pi's own retry among them, stops the count for
			// good, and the record says so for the loads that follow.
			if (aborted) {
				const counting = tries > 0 || failed;
				countAfresh();
				if (counting) mark({ attempt: 0 });
				return;
			}
			if (reply && isCapRefusal(reply.errorMessage)) {
				countAfresh();
				moveOffCap(ctx, reply);
				return;
			}
			if (!reply || !failed) {
				countAfresh();
				if (reply && !reply.errorMessage) movedOffCap = false;
				return;
			}
			// A failure the provider billed may fail so every try, at full
			// price, so a streak of them gets only a few.
			if (wasBilled(reply)) billed++;
			if (billed > MOST_BILLED_TRIES) {
				countAfresh();
				mark({ attempt: 0 });
				ctx.ui.notify(
					`The model call failed again: ${failureLine(reply)}. Its failures were billed, so the harness stopped after ${MOST_BILLED_TRIES} tries. Type to try again.`,
					"warning",
				);
				return;
			}
			const attempt = tries + 1;
			const delay = waitBefore(attempt) ?? FIRST_WAIT_MS;
			mark({ attempt, due: Date.now() + delay });
			wait(ctx, attempt, delay, reply);
		},
		started() {
			stopWaiting();
		},
		typed() {
			handBack();
		},
		prompting(open) {
			prompts = open;
		},
		stop() {
			stopWaiting();
		},
	};
}

/** What the model reads as the try begins. */
function retryText(attempt: number, line: string): string {
	return `The last model call failed (${line}) after pi's own retries. The harness waited and is trying again (try ${attempt}): carry on from where you left off.`;
}

/** What the model reads as the try on a capped key's budget begins. */
function cappedText(budget: string, line: string): string {
	return `The last model call was refused because the person's own key is over its cap (${line}). The session now draws on budget ${budget}, so the harness is trying again: carry on from where you left off.`;
}

function clearMark(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}
