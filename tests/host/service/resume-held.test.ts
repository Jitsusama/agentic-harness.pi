/** The phases a start's resume of what the host held marks, as the journal says them. */
import { describe, expect, it, vi } from "vitest";
import type { StartPhase } from "../../../host/service/backend.ts";
import { resumeHeld } from "../../../host/service/resume-held.ts";
import { type PhaseEnd, phaseTimes } from "../../../host/service/status.ts";
import type { RosterEntry } from "../../../lib/core/session/roster.ts";
import {
	children,
	engine,
	entry,
	roster,
	useBackendBed,
} from "./support/backend-children.ts";

useBackendBed();

/** How long an earlier host's child takes to let go of the log. */
const LEFT_MS = 30_000;
/** How long the engine takes to open the log once it is let go. */
const OPEN_MS = 1_000;

/**
 * A clock the case moves by hand, so a wait is a number rather than a
 * sleep, and the phases each resume marks against it.
 */
function phaseClock() {
	let now = 0;
	const phases: PhaseEnd[] = [];
	return {
		phases,
		pass: (ms: number) => {
			now += ms;
		},
		mark: (_step: unknown, phase: StartPhase) => {
			phases.push({ phase, at: now });
		},
		said: () => phaseTimes(0, phases, now),
	};
}

/** An engine whose resume opens the log in `OPEN_MS` and marks it. */
function opening(clock: ReturnType<typeof phaseClock>) {
	return {
		...engine(),
		resume: vi.fn(
			async (
				_entry: RosterEntry,
				_woken?: boolean,
				mark?: (phase: StartPhase) => void,
			) => {
				clock.pass(OPEN_MS);
				mark?.("log");
			},
		),
	};
}

describe("a start's resume of one that stays in the host", () => {
	it("says the wait for an earlier host's child under left, and only the open under log", async () => {
		const staying = entry();
		await roster.hold(staying);
		const clock = phaseClock();
		const moved = children([]);
		moved.fake.left.mockImplementationOnce(async () => clock.pass(LEFT_MS));

		await resumeHeld({
			roster,
			engine: opening(clock),
			children: moved.fake,
			mark: clock.mark,
		});

		expect(clock.said()).toBe(
			" (ask 0.0 s, gate 0.0 s, left 30.0 s, log 1.0 s, rest 0.0 s)",
		);
	});
});

describe("a start's resume of one that moves into a child", () => {
	it("marks no left, since no earlier host's child is waited on", async () => {
		const moving = entry();
		await roster.hold(moving);
		const clock = phaseClock();
		const moved = children([moving.sessionId]);

		await resumeHeld({
			roster,
			engine: opening(clock),
			children: moved.fake,
			mark: clock.mark,
		});

		expect(clock.phases.map(({ phase }) => phase)).toEqual(["ask", "gate"]);
	});
});
