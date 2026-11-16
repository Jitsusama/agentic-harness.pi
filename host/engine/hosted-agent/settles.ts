/**
 * Telling pi's extensions that a run the agent began itself has settled,
 * as pi tells them when one of its own does. pi settles only runs it
 * began, so an extension waiting on a settle, as job-workflow's outbox
 * does, waited after a restart until a person typed (15 November).
 */
import type { DurableBinding } from "./binding.ts";
import type { Run } from "./run.ts";

/** pi's session, as far as telling its extensions a run settled needs it. */
export interface SettlingSession {
	/** Whether a run of pi's own is under way, which settles as pi's run ends. */
	readonly isStreaming: boolean;
	/** Read at each settle: a reload replaces it. */
	readonly extensionRunner: {
		emit(event: {
			readonly type: "agent_settled";
			readonly aborted: boolean;
		}): Promise<unknown>;
	};
}

/** The settles of the agent's own runs, told to the session the host gives it. */
export class OwnSettles {
	private readonly durable: Pick<DurableBinding, "within">;
	/** Whether the host is stopping, when nothing settles. */
	private readonly parked: () => boolean;
	private session: SettlingSession | undefined;

	constructor(durable: Pick<DurableBinding, "within">, parked: () => boolean) {
		this.durable = durable;
		this.parked = parked;
	}

	/** Tell `session`'s extensions from now on. */
	tell(session: SettlingSession): void {
		this.session = session;
	}

	/** Say a run nobody awaits settled, once it ends, as one durable carries on alone. */
	after(run: Promise<Run>): void {
		run
			.then((ended) => this.settled([ended]))
			.catch(() => {
				// The run's failure is shown to pi as its end, and pi's runner reports an extension's.
			});
	}

	/**
	 * Say that `runs`, begun by the agent itself, have settled, aborted if
	 * any was, when pi was shown one begin. A run of pi's own under way, as
	 * words queued behind the recovery begin, settles as pi's run ends.
	 */
	async settled(runs: readonly Run[]): Promise<void> {
		const session = this.session;
		const shown = runs.filter((run) => run.opened);
		if (!session || shown.length === 0 || this.parked()) return;
		if (session.isStreaming) return;
		const aborted = shown.some((run) => run.controller.signal.aborted);
		const say = () =>
			session.extensionRunner.emit({ type: "agent_settled", aborted });
		// As each listener runs: as the conversation's own, whoever scheduled it.
		await (this.durable.within ? this.durable.within(say) : say());
	}
}
