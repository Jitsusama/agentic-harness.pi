/**
 * A round's bus when its session reloads under it.
 *
 * A started round waits in the machine's line for up to two hours and
 * then says it is running, by asking for a job host on the bus. Pi
 * refuses everything said on a bus whose load a reload replaced, so on
 * 25 November rounds that waited through an install move were refused
 * with pi's stale-context error the moment they started, their
 * reviewers already dispatched and nobody watching them. The bus a
 * round holds says what it says on the newest load's bus.
 */

import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	liveBus,
	rememberBus,
} from "../../../../extensions/review-integration/engine.ts";
import { watchStartedRound } from "../../../../extensions/review-integration/round-job.ts";
import {
	announceJobHost,
	findJobHost,
	type JobHost,
} from "../../../../lib/jobs/index.ts";

/** What pi says when a replaced load's bus is used. */
const STALE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.reload().";

/** One load's view of the process's bus, refusing all once replaced. */
function load(shared: EventBus): { bus: EventBus; replace(): void } {
	let stale = false;
	return {
		bus: {
			emit(channel, data) {
				if (stale) throw new Error(STALE);
				shared.emit(channel, data);
			},
			on(channel, handler) {
				if (stale) throw new Error(STALE);
				return shared.on(channel, handler);
			},
		},
		replace: () => {
			stale = true;
		},
	};
}

/** A job host that keeps the labels of the jobs it was asked to start. */
function jobHost(started: string[]): JobHost {
	return {
		start: (job) => {
			started.push(job.label);
			return {
				id: `j${started.length}`,
				signal: new AbortController().signal,
				finish: () => {},
				onDelivered: () => {},
				withdraw: () => false,
			};
		},
	};
}

describe("the bus a round holds through a reload", () => {
	it("finds the job host the reloaded load announces", () => {
		const shared = createEventBus();
		const first = load(shared);
		rememberBus(first.bus);
		const held = liveBus(first.bus);

		first.replace();
		const second = load(shared);
		rememberBus(second.bus);
		const started: string[] = [];
		const dispose = announceJobHost(second.bus, jobHost(started));
		try {
			expect(() => first.bus.emit("anything", undefined)).toThrow(STALE);
			expect(findJobHost(held)).toBeDefined();
		} finally {
			dispose();
		}
	});

	it("starts the watch of a round that started after the reload", () => {
		const shared = createEventBus();
		const first = load(shared);
		rememberBus(first.bus);
		const held = liveBus(first.bus);

		first.replace();
		const second = load(shared);
		rememberBus(second.bus);
		const started: string[] = [];
		const dispose = announceJobHost(second.bus, jobHost(started));
		try {
			watchStartedRound({
				bus: held,
				runId: "council-1",
				label: "council council-1 on o/r#1",
				participants: ["hawk"],
				isRunning: async () => false,
				stop: async () => {},
				pollMs: 10,
			});
			expect(started).toEqual(["council council-1 on o/r#1"]);
		} finally {
			dispose();
		}
	});
});
