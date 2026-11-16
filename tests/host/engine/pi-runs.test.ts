/** The agent's own runs opened and settled as runs of pi's, through a session standing in for pi's runForHost. */
import { describe, expect, it } from "vitest";
import {
	type HostRunningSession,
	PiRuns,
} from "../../../host/engine/hosted-agent/pi-runs.ts";

/** A session that runs work as pi's runForHost does, noting each run it opens and settles. */
function piSession(streaming = false) {
	const said: string[] = [];
	const session: HostRunningSession = {
		isStreaming: streaming,
		async runForHost(work) {
			said.push("prepared");
			await work();
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

	it("opens nothing for work nobody holds", async () => {
		const { session, said } = piSession();
		const runs = new PiRuns(() => false);
		runs.tell(session);

		await runs.opening();

		expect(said).toEqual([]);
	});

	it("leaves a run pi began to pi", async () => {
		const { session, said } = piSession(true);
		const runs = new PiRuns(() => false);
		runs.tell(session);

		await runs.holding(() => runs.opening());

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
