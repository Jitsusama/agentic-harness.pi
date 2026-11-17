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
			void release();
		} finally {
			vi.useRealTimers();
		}
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
		parked = true;
		await runs.holding(() => runs.opening());

		expect(
			settles,
			"one settle each for the shown runs, none unshown, inside pi's own or once parked",
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
