/**
 * A line the person types during a run moves a long call to the
 * background soon after, so pi can read the line; a quick call still
 * answers for itself, and a line from anywhere else moves nothing.
 */

import {
	type AgentToolResult,
	createEventBus,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { runOrHandOff } from "../../../lib/jobs/hand-off.ts";
import { announceJobHost, type JobSpec } from "../../../lib/jobs/index.ts";
import {
	answerSteerWaiting,
	onSteered,
	saySteered,
	steerWaiting,
} from "../../../lib/jobs/steer.ts";

/** A minute, as a call waits before it moves on its own. */
const MINUTE_MS = 60_000;

/** How long a call runs on once a line is typed, in these tests. */
const STEERED_MS = 20;

/**
 * How long a test waits for a call that should have moved. Far short of
 * the minute, so a call that waited it out fails here, not at the
 * test's own timeout.
 */
const MOVES_WITHIN_MS = 2_000;

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

/** A bus with a job host that records what it was asked to hold. */
function recordingHost() {
	const bus = createEventBus();
	const specs: JobSpec[] = [];
	disposers.push(
		announceJobHost(bus, {
			start(spec) {
				specs.push(spec);
				return {
					id: `j${specs.length}`,
					signal: new AbortController().signal,
					finish: () => {},
					onDelivered: () => {},
					withdraw: () => false,
				};
			},
		}),
	);
	return { bus, specs };
}

const said = (text: string): AgentToolResult<undefined> => ({
	content: [{ type: "text", text }],
	details: undefined,
});

/** A call that runs until it is told to end. */
function controllable() {
	let end: (result: AgentToolResult<undefined>) => void = () => {};
	const run = () =>
		new Promise<AgentToolResult<undefined>>((resolve) => {
			end = resolve;
		});
	return { run, end: (result: AgentToolResult<undefined>) => end(result) };
}

/** Run a call through the hand-off as a tool would, waiting a minute. */
function call(
	bus: ReturnType<typeof createEventBus>,
	run: () => Promise<AgentToolResult<undefined>>,
) {
	return runOrHandOff({
		kind: "script",
		label: "a long script",
		noun: "background script",
		stopping: (jobId) => `Stop it with ${jobId}.`,
		filePrefix: "pi-test",
		session: `test-${process.pid}`,
		nested: false,
		signal: undefined,
		onUpdate: undefined,
		bus,
		run,
		afterMs: MINUTE_MS,
		steeredMs: STEERED_MS,
	});
}

/** The text a result says, or what a call that never answered says. */
async function answered(
	running: Promise<AgentToolResult<unknown>>,
): Promise<string> {
	const late = new Promise<string>((resolve) =>
		setTimeout(() => resolve("no answer in time"), MOVES_WITHIN_MS),
	);
	const result = await Promise.race([running, late]);
	if (typeof result === "string") return result;
	return result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

describe("a line the person types during a run", () => {
	it("moves a long call to the background soon after", async () => {
		const { bus, specs } = recordingHost();
		const script = controllable();
		const running = call(bus, script.run);
		saySteered(bus);
		const text = await answered(running);

		expect(specs, "the call moved to a job").toHaveLength(1);
		expect(text).toContain("so the person's new message can be read");
		expect(text).toContain("background script j1");
		script.end(said("done"));
	});

	it("moves a call started while the line still waits", async () => {
		const { bus, specs } = recordingHost();
		disposers.push(answerSteerWaiting(bus, () => true));
		const script = controllable();
		const text = await answered(call(bus, script.run));

		expect(specs, "the call moved to a job").toHaveLength(1);
		expect(text).toContain("so the person's new message can be read");
		script.end(said("done"));
	});

	it("lets a quick call answer for itself", async () => {
		const { bus, specs } = recordingHost();
		const script = controllable();
		const running = call(bus, script.run);
		saySteered(bus);
		script.end(said("done"));

		expect(await answered(running)).toBe("done");
		expect(specs, "no job was started").toEqual([]);
	});

	it("moves nothing when no line was typed", async () => {
		const { bus, specs } = recordingHost();
		disposers.push(answerSteerWaiting(bus, () => false));
		const script = controllable();
		const running = call(bus, script.run);

		expect(await answered(running)).toBe("no answer in time");
		expect(specs, "no job was started").toEqual([]);
		script.end(said("done"));
		await running;
	});
});

describe("whether a line waits", () => {
	it("is false when nobody holds one", () => {
		expect(steerWaiting(createEventBus()), "no line waits").toBe(false);
	});

	it("is true when anybody holds one", () => {
		const bus = createEventBus();
		disposers.push(answerSteerWaiting(bus, () => false));
		disposers.push(answerSteerWaiting(bus, () => true));

		expect(steerWaiting(bus), "a line waits").toBe(true);
	});

	it("is heard each time a line is typed", () => {
		const bus = createEventBus();
		let heard = 0;
		disposers.push(onSteered(bus, () => heard++));
		saySteered(bus);
		saySteered(bus);

		expect(heard).toBe(2);
	});
});
