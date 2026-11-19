/**
 * The agent's own runs as runs of pi's: a run the host begins itself, as
 * when it carries a cut-off turn on after a restart, is opened in pi's
 * session through the runtime's runForHost seam the moment pi is first
 * shown it. pi then prepares it as it prepares a prompt's run, every
 * extension adding its sections at before_agent_start, and settles it once
 * the host's work is over. Before the seam, such a run reached the model
 * without the harness's resident block (271 requests in one probe on 16
 * November) and settled only by the host's word (15 November).
 *
 * What pi prepares for such a run, as the update to its sections when
 * they changed since the conversation last ran, it hands the host's work
 * rather than placing itself, since the host holds the run's transcript:
 * placed among the messages the run's next request shows, it lands after
 * every tool result that request owes, so no call is parted from its
 * result. A runtime whose seam hands nothing over leaves pi to correct
 * the sections from the run's second turn, as before.
 *
 * A runtime with no seam at all, as a host restarted before its runtime
 * moved runs, opens no run of pi's, so pi settles none: its extensions
 * are told each settle here instead, as they were before the seam, or one
 * waiting on it, as job-workflow's outbox does, waits until a person types
 * (15 November). pi settles no run it failed to prepare either, so that
 * run's settle is said here too.
 */

import type { AgentMessage } from "../pi-types.ts";

/** pi's session, as far as running the agent's own runs as its own needs it. */
export interface HostRunningSession {
	/** Whether a run of pi's is under way, which pi prepares and settles itself. */
	readonly isStreaming?: boolean;
	/**
	 * Run `work` as a run of pi's: prepared as a prompt's, then settled once
	 * `work` ends. `work` is handed what pi prepared for the run's first
	 * request, which an older seam leaves out. Inside a run of pi's already
	 * under way, `work` joins it and is handed nothing.
	 */
	runForHost?(
		work: (prepared?: readonly AgentMessage[]) => Promise<void>,
	): Promise<void>;
	/** Read at each settle, on a runtime with no seam: a reload replaces it. */
	readonly extensionRunner?: {
		emit(event: {
			readonly type: "agent_settled";
			readonly aborted: boolean;
		}): Promise<unknown>;
	};
}

/**
 * How long a run waits for pi to prepare it before going on with nothing
 * handed over: pi's before_agent_start handlers answer in milliseconds, and
 * one that never does would hold one of the host's resume slots for good.
 */
export const PREPARING_MS = 30_000;

/** Milliseconds in a second, for saying PREPARING_MS. */
const MS_PER_SECOND = 1_000;

/** Runs `say` as the conversation's own, whoever scheduled it. */
export type Within = (say: () => Promise<unknown>) => Promise<unknown>;

/** Where a run pi didn't prepare is said, so a run sent on without its sections isn't silent. */
export type Report = (error: unknown) => void;

/**
 * Run the words waiting in pi's queue, answering whether they went: false
 * when none waited, or some still wait after the run, so carrying on again
 * would only go round.
 */
export type RunWaiting = () => Promise<boolean>;

/**
 * An open run of pi's, ended by `end`, done once `settled` resolves, true
 * when pi settled it and false when pi failed to prepare it, or given up
 * on once `overdue` does, as pi never prepared it in time. `signal` is the
 * run's stop, for a settle said here.
 */
interface OpenRun {
	readonly end: () => void;
	readonly settled: Promise<boolean>;
	readonly overdue: Promise<void>;
	readonly signal: AbortSignal | undefined;
}

/**
 * The span of the agent's own work each run of pi's covers. Each of the
 * agent's runs holds it while it runs, and a recovery holds it across its
 * carried run and its ask again, so pi sees one run and one settle for
 * both, as it would for a run of its own and its continues.
 */
export class PiRuns {
	private readonly parked: () => boolean;
	private readonly within: Within;
	private readonly next: () => void;
	private readonly runWaiting: RunWaiting;
	private session: HostRunningSession | undefined;
	private report: Report = () => {};
	private holds = 0;
	private open: OpenRun | undefined;
	/** The stop signals of runs shown pi with no seam to open them, for the settle owed. */
	private unseamed: (AbortSignal | undefined)[] | undefined;
	/** The stop signals of every run shown pi while held, since a stop of any ends pi's run going on. */
	private shown: (AbortSignal | undefined)[] = [];

	/**
	 * Runs whose host is stopping once `parked` says so, each settle said
	 * `within`. Before the last hold ends a run pi opened, `runWaiting`
	 * runs the words that wait inside it, again for as long as words wait
	 * and no run shown was stopped, as pi's own run continues on queued
	 * words before it settles: they waited, in memory alone, through every
	 * settle handler, and a host dying then lost them. Words queued after
	 * that go on to `next` once pi's run settled, since pi starts no run
	 * for them after a host's.
	 */
	constructor(
		parked: () => boolean,
		within: Within = (say) => say(),
		next: () => void = () => {},
		runWaiting: RunWaiting = async () => false,
	) {
		this.parked = parked;
		this.within = within;
		this.next = next;
		this.runWaiting = runWaiting;
	}

	/** Open runs in `session` from now on, saying to `report` each run pi didn't prepare. */
	tell(session: HostRunningSession, report?: Report): void {
		this.session = session;
		if (report) this.report = report;
	}

	/**
	 * Hold pi's run, once it opens, until the answer is called; that answer
	 * resolves once pi settled it, when it was the last hold.
	 */
	hold(): () => Promise<void> {
		this.holds += 1;
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			// Still held, so the runs carried on join pi's open run, which settles once after them.
			if (this.holds === 1 && this.open) await this.carryOnWaiting();
			this.holds -= 1;
			if (this.holds > 0) return;
			this.shown = [];
			const open = this.open;
			this.open = undefined;
			const unseamed = this.unseamed;
			this.unseamed = undefined;
			// A parked host is stopping and shows pi nothing more: its run stays
			// open, unsettled, and goes with the session, so no extension wakes to
			// act on a conversation that is closing.
			if (this.parked()) return;
			if (unseamed) await this.settledWithoutSeam(unseamed);
			if (!open) return;
			open.end();
			// pi settles a run it never finished preparing only once it has, which a
			// handler that never answers puts off for good: the run ends without it.
			// Words queued since go on only once pi settles, so no run hears that settle.
			// pi settles no run it failed to prepare, so that settle is said here, as
			// on a pi with no seam.
			const done = open.settled.then(async (piSettled) => {
				if (this.parked()) return;
				if (!piSettled) await this.settledWithoutSeam([open.signal]);
				this.next();
			});
			await Promise.race([done, open.overdue]);
		};
	}

	/** Run what waits in pi's queue until none does, as pi's own run goes on to none once stopped or parked. */
	private async carryOnWaiting(): Promise<void> {
		const stopped = () => this.shown.some((signal) => signal?.aborted === true);
		while (!this.parked() && !stopped()) {
			// A run carried on shows its own failure, and this hold still ends.
			const went = await this.runWaiting().catch(() => false);
			if (!went) return;
		}
	}

	/** Tell pi's extensions the runs shown settled, unless pi's own run under way settles them. */
	private async settledWithoutSeam(
		signals: readonly (AbortSignal | undefined)[],
	): Promise<void> {
		const runner = this.session?.extensionRunner;
		if (!runner || this.session?.isStreaming) return;
		const aborted = signals.some((signal) => signal?.aborted === true);
		await this.within(() => runner.emit({ type: "agent_settled", aborted }));
	}

	/**
	 * Run `work` holding pi's run, and resolve as pi's prompt resolves: once
	 * pi settled the run, when it was the last hold.
	 */
	async holding<T>(work: () => Promise<T>): Promise<T> {
		const release = this.hold();
		try {
			return await work();
		} finally {
			await release();
		}
	}

	/**
	 * Open pi's run for the work held, if none is open, before pi is shown
	 * its start, and resolve once pi prepared it, every extension adding
	 * its sections, as for a prompt. Answers what pi prepared for the run's
	 * first request, for the run to place. Inside a run of pi's own, as when
	 * pi's prompt reached the agent, the work is that run's, which pi
	 * settles, and a run of the agent's after it opens its own.
	 */
	async opening(signal?: AbortSignal): Promise<readonly AgentMessage[]> {
		const session = this.session;
		if (this.holds > 0) this.shown.push(signal);
		if (this.open || this.holds === 0 || !session) return [];
		if (session.isStreaming) return [];
		if (!session.runForHost) {
			// No seam opens pi's run, so the settle it owes is said as the hold ends.
			this.unseamed = [...(this.unseamed ?? []), signal];
			return [];
		}
		let end = () => {};
		const ended = new Promise<void>((done) => {
			end = done;
		});
		let begun = (_handed: readonly AgentMessage[]) => {};
		const prepared = new Promise<readonly AgentMessage[]>((done) => {
			begun = done;
		});
		const report = this.report;
		const settled = session
			.runForHost((handed) => {
				begun(handed ?? []);
				return ended;
			})
			.then(
				() => true,
				(error: unknown) => {
					// The host's work goes on either way, but a run pi failed to prepare goes without its sections, which is said.
					report(new Error(`pi's run for the host failed: ${String(error)}`));
					return false;
				},
			);
		let late = () => {};
		const overdue = new Promise<void>((done) => {
			late = done;
		});
		this.open = { end, settled, overdue, signal };
		// A run pi failed to prepare, took too long over, or that was stopped
		// meanwhile, hands nothing over, and the work goes on; one prepared late
		// ends with it as any other.
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stop = () => {};
		const unprepared = new Promise<readonly AgentMessage[]>((done) => {
			const give = () => {
				late();
				done([]);
			};
			const overdue = () => {
				report(
					new Error(
						`pi took over ${PREPARING_MS / MS_PER_SECOND} s to prepare the host's run, so it goes on without the sections pi adds`,
					),
				);
				give();
			};
			timer = setTimeout(overdue, PREPARING_MS);
			stop = give;
			if (signal?.aborted) give();
			else signal?.addEventListener("abort", give, { once: true });
		});
		try {
			return await Promise.race([prepared, settled.then(() => []), unprepared]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
		}
	}
}
