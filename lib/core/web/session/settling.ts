/**
 * Waiting for a page to stop changing, so a read that follows
 * describes where the page ended up rather than where it was.
 *
 * The DOM and the network each miss a case the other catches,
 * so both have to hold at once, and since satisfying one can
 * disturb the other they are rechecked together until they
 * agree or the budget runs out.
 */

import { bounded, WallClockExceeded } from "../bound.ts";
import type { NetworkRequest } from "../telemetry/index.ts";
import {
	inFlight,
	SETTLE_BUDGET_MS,
	SETTLE_QUIET_MS,
	type Settled,
	settleSource,
} from "../wait/index.ts";
import type { SessionWires } from "./wires.ts";

/**
 * Whether the settle probe came back with what it promised.
 *
 * Page-side results arrive as unknown, and a navigation landing
 * mid-evaluate resolves with nothing at all, so this is narrowed
 * rather than asserted.
 */
function isSettled(value: unknown): value is Settled {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<Settled>;
	return (
		typeof candidate.quiet === "boolean" &&
		typeof candidate.waitedMs === "number" &&
		typeof candidate.mutations === "number"
	);
}

/**
 * How far past its own deadline the page-side probe may run before
 * it is taken as never going to answer. The probe counts its deadline
 * out on the page's own timer, and a page that runs no script never
 * fires one, so the bound has to be kept here as well.
 */
const PROBE_SLACK_MS = 500;

/**
 * How long a page with a free main thread gets to fire a zero-delay
 * timer before it is taken as running no script at all.
 */
const TIMER_PROBE_MS = 500;

/** Why a capped probe came back empty. */
type Silence = "no-script" | "busy";

/** A probe that did not answer in the time it was given. */
const LATE = Symbol("late");

/** A probe that can never answer, because the page runs no script. */
const NO_SCRIPT = Symbol("no script");

/** Wait here, since the page may be one whose timers never fire. */
function pause(ms: number): Promise<void> {
	return new Promise((wake) => setTimeout(wake, ms));
}

/** The wait between a change and an honest reading of it. */
export class PageSettler {
	/** What the last settle saw, so a reader can qualify its answer. */
	private last: Settled | undefined;

	constructor(
		private readonly wires: SessionWires,
		/** The request log, for what may yet rewrite the page. */
		private readonly requests: () => readonly NetworkRequest[],
	) {}

	/** What the last settle saw, for a reader that wants to say so. */
	get lastSeen(): Settled | undefined {
		return this.last;
	}

	/**
	 * Wait for the page to stop changing.
	 *
	 * Returns what it found instead of throwing on a page that never
	 * settles: something that animates or polls for ever is still
	 * worth reading, as long as the answer does not pretend it was
	 * final.
	 *
	 * The budget is a parameter rather than only a constant because
	 * what it has to exceed is the quiet interval, and both stretch
	 * on a machine under load. A caller that needs "this page is
	 * quiet" to be answered reliably has to be able to say how long
	 * it is willing to wait for that, rather than inheriting a number
	 * chosen for an interactive read. Two browser tests asserting
	 * exactly that property failed intermittently for want of this.
	 */
	async settle(budgetMs: number = SETTLE_BUDGET_MS): Promise<Settled> {
		const started = Date.now();
		let mutations = 0;
		let quiet = false;
		// The DOM and the network each miss a case the other catches.
		//
		// A client-side navigation waiting on a fetch touches nothing
		// for as long as the request takes, so the DOM goes quiet and
		// the page then changes completely a moment later: pressing
		// Enter on a search box answered with the pre-search page for
		// exactly this reason. Meanwhile Chrome's network idle fires
		// before an app that already has its data has rendered any of
		// it.
		//
		// So both have to hold at once, and since satisfying one can
		// disturb the other, they are rechecked together until they
		// agree or the budget runs out.
		let scriptless = false;
		while (Date.now() - started < budgetMs) {
			const left = budgetMs - (Date.now() - started);
			if (scriptless) {
				// Nothing in the page can change it, so only the
				// network is left to wait on.
				quiet = inFlight(this.requests()).length === 0;
				if (quiet) break;
				await pause(Math.min(SETTLE_QUIET_MS, left));
				continue;
			}
			const outcome = await this.probe(left);
			if (outcome === NO_SCRIPT) {
				scriptless = true;
				continue;
			}
			if (isSettled(outcome)) {
				mutations += outcome.mutations;
				quiet = outcome.quiet;
			} else {
				// A navigation landed mid-evaluate, which is itself the
				// change we are waiting out. Go round again.
				quiet = false;
			}
			if (!quiet) continue;
			if (inFlight(this.requests()).length === 0) break;
			// Something is outstanding that may yet rewrite the page.
			quiet = false;
		}
		this.last = {
			quiet,
			waitedMs: Date.now() - started,
			mutations,
		};
		return this.last;
	}

	/**
	 * Run the page-side settle probe for at most `left`, with its
	 * deadline kept here as well as on the page.
	 *
	 * A probe that has not answered by the time a quiet page would
	 * have is asked why. A page that runs no script can never answer,
	 * and finding that out now rather than at the end of the budget
	 * is the difference between a navigation taking one second and
	 * taking three. A page that is merely busy is waited on as before.
	 */
	private async probe(left: number): Promise<unknown> {
		const probe = this.wires
			.page()
			.evaluate(settleSource(SETTLE_QUIET_MS, left));
		const started = Date.now();
		const within = (wallMs: number) =>
			bounded(probe, { wallMs, what: "waiting for the page" }).catch(
				(err: unknown) => (err instanceof WallClockExceeded ? LATE : undefined),
			);
		const early = await within(
			Math.min(SETTLE_QUIET_MS + PROBE_SLACK_MS, left + PROBE_SLACK_MS),
		);
		if (early !== LATE) return early;
		if ((await this.silence()) === "no-script") return NO_SCRIPT;
		// Asking may have outlasted the deadline, but an answer that
		// arrived meanwhile is still the answer, so look once more.
		const rest = left + PROBE_SLACK_MS - (Date.now() - started);
		const late = await within(Math.max(rest, 0));
		return late === LATE ? undefined : late;
	}

	/**
	 * Tell a page that runs no script from one too busy to answer.
	 *
	 * A response carrying the CSP sandbox directive runs no script,
	 * and to Chrome a timer's callback is script, so its timers never
	 * fire even though an evaluate still runs at once. A page whose
	 * main thread is blocked answers neither, and is still changing.
	 */
	private async silence(): Promise<Silence> {
		const page = this.wires.page();
		const answers = (work: Promise<unknown>): Promise<boolean> =>
			bounded(work, { wallMs: TIMER_PROBE_MS, what: "probing the page" }).then(
				() => true,
				() => false,
			);
		if (await answers(page.evaluate("new Promise((r) => setTimeout(r, 0))"))) {
			return "busy";
		}
		return (await answers(page.evaluate("0"))) ? "no-script" : "busy";
	}
}
