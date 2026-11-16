/**
 * The agent's own runs as runs of pi's: a run the host begins itself, as
 * when it carries a cut-off turn on after a restart, is opened in pi's
 * session through the runtime's runForHost seam the moment pi is first
 * shown it. pi then prepares it as it prepares a prompt's run, every
 * extension adding its sections at before_agent_start, and settles it once
 * the host's work is over. Before the seam, such a run reached the model
 * without the harness's resident block (271 requests in one probe on 16
 * November) and settled only by the host's word (15 November).
 */

/** pi's session, as far as running the agent's own runs as its own needs it. */
export interface HostRunningSession {
	/** Whether a run of pi's is under way, which pi prepares and settles itself. */
	readonly isStreaming?: boolean;
	/**
	 * Run `work` as a run of pi's: prepared as a prompt's, then settled once
	 * `work` ends. Inside a run of pi's already under way, `work` joins it.
	 */
	runForHost?(work: () => Promise<void>): Promise<void>;
}

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
	private session: HostRunningSession | undefined;
	private holds = 0;
	private open: OpenRun | undefined;

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
			if (!open) return;
			open.end();
			await open.settled;
		};
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
	 * its sections, as for a prompt. Inside a run of pi's own, as when pi's
	 * prompt reached the agent, the work is that run's, which pi settles,
	 * and a run of the agent's after it opens its own.
	 */
	async opening(): Promise<void> {
		const session = this.session;
		if (this.open || this.holds === 0 || !session?.runForHost) return;
		if (session.isStreaming) return;
		let end = () => {};
		const ended = new Promise<void>((done) => {
			end = done;
		});
		let begun = () => {};
		const prepared = new Promise<void>((done) => {
			begun = done;
		});
		const settled = session
			.runForHost(() => {
				begun();
				return ended;
			})
			.catch(() => {
				// pi reports what failed in preparing or settling its run to its own listeners; the host's work goes on either way.
			});
		this.open = { end, settled };
		await Promise.race([prepared, settled]);
	}
}
