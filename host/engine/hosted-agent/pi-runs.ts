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
 * (15 November).
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

/** Runs `say` as the conversation's own, whoever scheduled it. */
export type Within = (say: () => Promise<unknown>) => Promise<unknown>;

/** An open run of pi's, ended by `end`, settled once `settled` resolves. */
interface OpenRun {
	readonly end: () => void;
	readonly settled: Promise<void>;
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
	private session: HostRunningSession | undefined;
	private holds = 0;
	private open: OpenRun | undefined;
	/** The stop signals of runs shown pi with no seam to open them, for the settle owed. */
	private unseamed: (AbortSignal | undefined)[] | undefined;

	/**
	 * Runs whose host is stopping once `parked` says so, each settle said
	 * `within`, going on to `next` once pi's run settled, as pi's own run
	 * goes on to words that wait: pi starts none for them after a host's.
	 */
	constructor(
		parked: () => boolean,
		within: Within = (say) => say(),
		next: () => void = () => {},
	) {
		this.parked = parked;
		this.within = within;
		this.next = next;
	}

	/** Open runs in `session` from now on. */
	tell(session: HostRunningSession): void {
		this.session = session;
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
			this.holds -= 1;
			if (this.holds > 0) return;
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
			await open.settled;
			if (!this.parked()) this.next();
		};
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
		const settled = session
			.runForHost((handed) => {
				begun(handed ?? []);
				return ended;
			})
			.catch(() => {
				// pi reports what failed in preparing or settling its run to its own listeners; the host's work goes on either way.
			});
		this.open = { end, settled };
		// A run pi failed to prepare, or took too long over, hands nothing over,
		// and the work goes on; one prepared late ends with it as any other.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const overdue = new Promise<readonly AgentMessage[]>((done) => {
			timer = setTimeout(() => done([]), PREPARING_MS);
		});
		try {
			return await Promise.race([prepared, settled.then(() => []), overdue]);
		} finally {
			clearTimeout(timer);
		}
	}
}
