/** The agent's own runs opened and settled as runs of pi's, through a session standing in for pi's runForHost. */
import { describe, expect, it, vi } from "vitest";
import {
	type HostRunningSession,
	PiRuns,
	PREPARING_MS,
} from "../../../host/engine/hosted-agent/pi-runs.ts";
import type { AgentMessage } from "../../../host/engine/pi-types.ts";

/** The update pi prepares when a run's sections changed since the conversation last ran. */
const SECTION_UPDATE = {
	role: "user",
	content: "the sections now in force",
	timestamp: 0,
} as unknown as AgentMessage;

/**
 * A session that runs work as pi's runForHost does, noting each run it
 * opens and settles, and handing the work `handed`, as a seam that hands
 * nothing over does when it is undefined.
 */
function piSession(streaming = false, handed?: readonly AgentMessage[]) {
	const said: string[] = [];
	const session: HostRunningSession = {
		isStreaming: streaming,
		async runForHost(work) {
			said.push("prepared");
			await work(handed);
			said.push("settled");
		},
	};
	return { session, said };
}

describe("the agent's own runs in pi", () => {
	it("opens one run of pi's for nested holds, settling it once the last lets go", async () => {
		const { session, said } = piSession();
		const runs = new PiRuns(() => false);
		runs.tell(session);

		const carried = runs.hold();
		await runs.opening();
		const asked = runs.hold();
		await runs.opening();
		await carried();
		expect(said, "still held by the ask again").toEqual(["prepared"]);
		await asked();

		expect(said).toEqual(["prepared", "settled"]);
	});

	it("answers what pi prepared for the run's first request, for the run to place", async () => {
		const { session } = piSession(false, [SECTION_UPDATE]);
		const runs = new PiRuns(() => false);
		runs.tell(session);

		const release = runs.hold();
		const handed = await runs.opening();
		const again = await runs.opening();
		await release();

		expect(handed, "the update goes to the run").toEqual([SECTION_UPDATE]);
		expect(again, "once only, as the run opens").toEqual([]);
	});

	it("answers nothing from a seam that hands nothing over, or a start pi failed", async () => {
		const older = new PiRuns(() => false);
		older.tell(piSession().session);
		const failing = new PiRuns(() => false);
		failing.tell({
			runForHost: () => Promise.reject(new Error("a handler threw")),
		});

		const failingLater = new PiRuns(() => false);
		failingLater.tell({
			async runForHost() {
				await new Promise((resolve) => setTimeout(resolve, 5));
				throw new Error("a handler threw after a while");
			},
		});

		const fromOlder = await older.holding(() => older.opening());
		const fromFailed = await failing.holding(() => failing.opening());
		const fromLater = await failingLater.holding(() => failingLater.opening());

		expect(fromOlder, "an older seam").toEqual([]);
		expect(fromFailed, "a failed start").toEqual([]);
		expect(fromLater, "a start that failed later").toEqual([]);
	});

	it("says a run pi failed to prepare, which goes on without its sections", async () => {
		const said: unknown[] = [];
		const runs = new PiRuns(() => false);
		runs.tell(
			{ runForHost: () => Promise.reject(new Error("a handler threw")) },
			(error) => said.push(error),
		);

		await runs.holding(() => runs.opening());

		expect(said.map(String), "the failure is said").toEqual([
			expect.stringContaining("a handler threw"),
		]);
	});

	it("settles a run pi failed to prepare, as pi settles none it never began", async () => {
		// pi ends a run whose preparation threw without agent_settled, so an extension waiting on it would wait for a person (15 November).
		const settles: boolean[] = [];
		let next = 0;
		const runs = new PiRuns(
			() => false,
			(say) => say(),
			() => {
				next += 1;
			},
		);
		runs.tell({
			runForHost: () => Promise.reject(new Error("pi failed to prepare")),
			extensionRunner: {
				async emit(event) {
					settles.push(event.aborted);
				},
			},
		});

		await runs.holding(() => runs.opening());

		expect(settles, "one settle said for it").toEqual([false]);
		expect(next, "what waits goes on").toBe(1);
	});

	it("says a run pi took too long to prepare, and nothing for a stopped one", async () => {
		vi.useFakeTimers();
		try {
			const said: unknown[] = [];
			const overdue = new PiRuns(() => false);
			overdue.tell({ runForHost: () => new Promise(() => {}) }, (error) =>
				said.push(error),
			);
			const stopped = new PiRuns(() => false);
			stopped.tell({ runForHost: () => new Promise(() => {}) }, (error) =>
				said.push(error),
			);
			const stop = new AbortController();
			const releases = [overdue.hold(), stopped.hold()];
			void overdue.opening();
			void stopped.opening(stop.signal);
			stop.abort();

			await vi.advanceTimersByTimeAsync(PREPARING_MS);
			await Promise.all(releases.map((release) => release()));

			expect(said.map(String), "only the overdue run is said").toEqual([
				expect.stringContaining("to prepare the host's run"),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("goes on without pi's preparation once it is overdue", async () => {
		// A handler that never answers would hold one of the host's resume slots for good.
		vi.useFakeTimers();
		try {
			const runs = new PiRuns(() => false);
			runs.tell({ runForHost: () => new Promise(() => {}) });
			const release = runs.hold();
			let handed: readonly AgentMessage[] | undefined;
			void runs.opening().then((messages) => {
				handed = messages;
			});

			await vi.advanceTimersByTimeAsync(PREPARING_MS - 1);
			expect(handed, "still preparing").toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);

			expect(handed, "the run went on with nothing").toEqual([]);
			let ended = false;
			void release().then(() => {
				ended = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(ended, "the run ends without waiting on pi's preparation").toBe(
				true,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("goes on without pi's preparation once the run is stopped", async () => {
		// A stopped run would otherwise wait out the whole deadline for nothing.
		const runs = new PiRuns(() => false);
		runs.tell({ runForHost: () => new Promise(() => {}) });
		const release = runs.hold();
		const stopping = new AbortController();
		const opening = runs.opening(stopping.signal);
		stopping.abort();

		expect(await opening, "the run went on with nothing").toEqual([]);
		await release();
	});

	it("tells extensions a run settled on a pi with no seam, as before it", async () => {
		// pi settles only runs it began, so without the seam an extension waiting
		// on a settle, as job-workflow's outbox does, waited until a person typed.
		const settles: boolean[] = [];
		const session = (streaming: boolean): HostRunningSession => ({
			isStreaming: streaming,
			extensionRunner: {
				async emit(event) {
					settles.push(event.aborted);
				},
			},
		});
		const stopped = new AbortController();
		stopped.abort();
		let parked = false;
		const runs = new PiRuns(() => parked);

		runs.tell(session(false));
		await runs.holding(() => runs.opening());
		await runs.holding(() => runs.opening(stopped.signal));
		await runs.holding(async () => {});
		runs.tell(session(true));
		await runs.holding(() => runs.opening());
		runs.tell(session(false));
		await runs.holding(async () => {
			await runs.opening();
			runs.tell(session(true));
		});
		runs.tell(session(false));
		parked = true;
		await runs.holding(() => runs.opening());

		expect(
			settles,
			"one settle each for the shown runs, none unshown, inside pi's own, begun since or once parked",
		).toEqual([false, true]);
	});

	it("opens nothing for work nobody holds", async () => {
		const { session, said } = piSession();
		const runs = new PiRuns(() => false);
		runs.tell(session);

		await runs.opening();

		expect(said).toEqual([]);
	});

	it("leaves a run pi began to pi, and opens the next once pi's has ended", async () => {
		const { session: seam, said } = piSession();
		let streaming = true;
		const runs = new PiRuns(() => false);
		runs.tell({
			get isStreaming() {
				return streaming;
			},
			runForHost: seam.runForHost,
		});

		await runs.holding(() => runs.opening());
		expect(said, "inside pi's own run").toEqual([]);
		streaming = false;
		await runs.holding(() => runs.opening());

		expect(said, "once pi's run ended").toEqual(["prepared", "settled"]);
	});

	it("goes on to what waits from a run pi prepared late only once pi settles it", async () => {
		// The run that goes on would otherwise hear pi's late settle in its midst.
		vi.useFakeTimers();
		try {
			const said: string[] = [];
			let prepare = () => {};
			const preparing = new Promise<void>((done) => {
				prepare = done;
			});
			const runs = new PiRuns(
				() => false,
				(say) => say(),
				() => said.push("next"),
			);
			runs.tell({
				async runForHost(work) {
					await preparing;
					said.push("prepared");
					await work([]);
					said.push("settled");
				},
			});
			const release = runs.hold();
			void runs.opening();
			await vi.advanceTimersByTimeAsync(PREPARING_MS);
			await release();
			expect(said, "nothing goes on while pi prepares").toEqual([]);

			prepare();
			await vi.advanceTimersByTimeAsync(0);

			expect(said).toEqual(["prepared", "settled", "next"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("goes on to what waits once pi's run settled, as pi's own run does", async () => {
		// Words queued into pi's run after the agent's last run stopped taking
		// them wait on this, since pi starts no run for them after a host's.
		const { session, said } = piSession();
		const runs = new PiRuns(
			() => false,
			(say) => say(),
			() => said.push("next"),
		);
		runs.tell(session);

		const carried = runs.hold();
		await runs.opening();
		const asked = runs.hold();
		await carried();
		expect(said, "still held by the ask again").toEqual(["prepared"]);
		await asked();

		expect(said).toEqual(["prepared", "settled", "next"]);
	});

	it("carries words that wait on inside pi's run, before it settles, as pi's own run does", async () => {
		// Words pi queued as a carried run ended waited, in memory alone, until pi had settled it.
		const { session, said } = piSession();
		const runs = new PiRuns(
			() => false,
			(say) => say(),
			() => said.push("next"),
			async () => {
				said.push("carried on");
			},
		);
		runs.tell(session);

		const carried = runs.hold();
		await runs.opening();
		const asked = runs.hold();
		await carried();
		expect(said, "not while the ask again holds it").toEqual(["prepared"]);
		await asked();

		expect(said).toEqual(["prepared", "carried on", "settled", "next"]);
	});

	it("carries nothing on inside a run that was stopped or whose host parked", async () => {
		// pi's own run stops going on once it is aborted.
		const said: string[] = [];
		const carryOn = async () => {
			said.push("carried on");
		};
		const stopped = new PiRuns(
			() => false,
			(say) => say(),
			() => {},
			carryOn,
		);
		stopped.tell(piSession().session);
		const stop = new AbortController();
		const release = stopped.hold();
		void stopped.opening(stop.signal);
		stop.abort();
		await release();
		const parked = new PiRuns(
			() => true,
			(say) => say(),
			() => {},
			carryOn,
		);
		parked.tell(piSession().session);
		await parked.holding(() => parked.opening());

		expect(said).toEqual([]);
	});

	it("goes on to nothing once the host parks, even while pi settles", async () => {
		const said: string[] = [];
		let parked = false;
		const runs = new PiRuns(
			() => parked,
			(say) => say(),
			() => said.push("next"),
		);
		runs.tell({
			async runForHost(work) {
				await work([]);
				parked = true;
				said.push("settled");
			},
		});

		await runs.holding(() => runs.opening());

		expect(said).toEqual(["settled"]);
	});

	it("goes on to nothing inside pi's own run, which goes on itself, or where no seam opened one", async () => {
		const said: string[] = [];
		const next = () => said.push("next");
		const inside = new PiRuns(
			() => false,
			(say) => say(),
			next,
		);
		inside.tell(piSession(true).session);
		const unseamed = new PiRuns(
			() => false,
			(say) => say(),
			next,
		);
		unseamed.tell({ extensionRunner: { emit: async () => undefined } });

		await inside.holding(() => inside.opening());
		await unseamed.holding(() => unseamed.opening());

		expect(said).toEqual([]);
	});

	it("settles nothing once the host parks, as it shows pi nothing more", async () => {
		// A stopping host disposes pi's session; a settle then would wake
		// extensions to act on a conversation that is closing.
		const { session, said } = piSession();
		let parked = false;
		const runs = new PiRuns(() => parked);
		runs.tell(session);

		const release = runs.hold();
		await runs.opening();
		parked = true;
		await release();

		expect(said).toEqual(["prepared"]);
	});
});
