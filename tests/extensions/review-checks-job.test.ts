/**
 * Waiting on CI is held as a background job, so a model does not poll a
 * turn at a time or sleep in a shell for as long as CI takes.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_FAILED_LOOKS,
	watchChecks,
} from "../../extensions/review-integration/checks-job.ts";
import type { ChecksRollup } from "../../lib/core/review/index.ts";
import {
	announceJobHost,
	type Job,
	type JobOutcome,
	jobStopReason,
} from "../../lib/jobs/index.ts";

async function until(condition: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const controllers: AbortController[] = [];
const disposers: (() => void)[] = [];

afterEach(() => {
	for (const controller of controllers.splice(0))
		controller.abort(jobStopReason("session"));
	for (const dispose of disposers.splice(0)) dispose();
});

function recordingHost() {
	const bus = createEventBus();
	const outcomes: JobOutcome[] = [];
	disposers.push(
		announceJobHost(bus, {
			start(): Job {
				const controller = new AbortController();
				controllers.push(controller);
				return {
					id: `j${controllers.length}`,
					signal: controller.signal,
					finish: (outcome) => outcomes.push(outcome),
					onDelivered: () => {},
					withdraw: () => false,
				};
			},
		}),
	);
	return { bus, outcomes };
}

const rollup = (state: ChecksRollup["state"]): ChecksRollup => ({
	state,
	checks: [],
});

function watch(
	bus: ReturnType<typeof createEventBus>,
	read: () => Promise<ChecksRollup | null>,
	key = "gh:shop/app#7",
) {
	return watchChecks({
		bus,
		key,
		label: "shop/app#7",
		read,
		render: (r) => `state ${r.state}`,
		pollMs: 5,
	});
}

describe("watching checks", () => {
	it("says the settled result once CI is done", async () => {
		const { bus, outcomes } = recordingHost();
		let state: ChecksRollup["state"] = "pending";
		watch(bus, async () => rollup(state));

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(outcomes).toHaveLength(0);
		state = "failing";
		await until(() => outcomes.length > 0);

		expect(outcomes[0]?.summary).toContain("have settled: failing");
		expect(outcomes[0]?.summary).toContain("state failing");
	});

	it("refuses a second watch on the same change until the first ends", async () => {
		const { bus, outcomes } = recordingHost();
		let state: ChecksRollup["state"] = "pending";
		const read = async () => rollup(state);
		watch(bus, read);

		expect(watch(bus, read)).toBe("already-watching");
		state = "passing";
		await until(() => outcomes.length > 0);
		expect(typeof watch(bus, async () => rollup("pending"))).toBe("object");
	});

	it("says so when there is no host to hold it", () => {
		expect(
			watch(createEventBus(), async () => rollup("pending"), "other"),
		).toBe("no-host");
	});

	it("rides out a failed look, but gives up on a run of them", async () => {
		const { bus, outcomes } = recordingHost();
		let looks = 0;
		watch(bus, async () => {
			looks += 1;
			throw new Error("rate limited");
		});

		await until(() => outcomes.length > 0);

		expect(looks).toBe(MAX_FAILED_LOOKS);
		expect(outcomes[0]?.failed).toBe(true);
		expect(outcomes[0]?.summary).toContain("rate limited");
	});

	it("says when checks were still pending at the end of the watch", async () => {
		const { bus, outcomes } = recordingHost();
		let clock = 0;
		watchChecks({
			bus,
			key: "gh:slow",
			label: "slow",
			read: async () => {
				clock += 1000;
				return rollup("pending");
			},
			render: () => "",
			pollMs: 5,
			watchMs: 3000,
			now: () => clock,
		});

		await until(() => outcomes.length > 0);

		expect(outcomes[0]?.summary).toContain("still pending");
	});
});
