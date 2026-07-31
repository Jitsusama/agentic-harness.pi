/**
 * The advisory half of the publish check.
 *
 * This is the part that has to fail safely. A listener that throws, hangs or was
 * never loaded must not stop a push, because the alternative is a working layer
 * that stops working when an unrelated extension has a bad day, which is the
 * first thing anybody would turn off.
 */

import { describe, expect, it, vi } from "vitest";
import { objectionsTo } from "../../extensions/work-integration/broker.js";
import { WORK_PUBLISH_CHECK } from "../../lib/work/index.js";

const INTENT = {
	repoKey: "github:Jitsusama/agentic-harness.pi",
	branch: "topic",
	treePath: "/trees/topic",
	replacing: false,
};

/** A stand-in for pi's event bus, with the two methods this uses. */
function bus(): {
	pi: { events: { emit: (name: string, payload: unknown) => void } };
	listen: (name: string, run: (payload: unknown) => void) => void;
} {
	const listeners = new Map<string, ((payload: unknown) => void)[]>();
	return {
		pi: {
			events: {
				emit(name, payload) {
					for (const run of listeners.get(name) ?? []) run(payload);
				},
			},
		},
		listen(name, run) {
			listeners.set(name, [...(listeners.get(name) ?? []), run]);
		},
	};
}

describe("asking whether anybody objects", () => {
	it("collects nothing when nothing is listening", async () => {
		const { pi } = bus();

		// biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's bus
		expect(await objectionsTo(pi as any, INTENT)).toEqual([]);
	});

	it("collects an objection a listener raises straight away", async () => {
		const { pi, listen } = bus();
		listen(WORK_PUBLISH_CHECK, (raw) => {
			(raw as { object: (one: unknown) => void }).object({
				from: "meteorite",
				reason: "queued to merge",
			});
		});

		// biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's bus
		const found = await objectionsTo(pi as any, INTENT);

		expect(found).toEqual([{ from: "meteorite", reason: "queued to merge" }]);
	});

	it("waits for a listener that has to go and ask", async () => {
		// Without this the check races the push it is meant to gate, and would
		// pass most of the time and fail exactly when the backend was slow.
		const { pi, listen } = bus();
		listen(WORK_PUBLISH_CHECK, (raw) => {
			const asked = raw as {
				object: (one: unknown) => void;
				waitFor: (work: Promise<unknown>) => void;
			};
			asked.waitFor(
				new Promise<void>((done) =>
					setTimeout(() => {
						asked.object({ from: "github", reason: "waiting on checks" });
						done();
					}, 30),
				),
			);
		});

		// biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's bus
		const found = await objectionsTo(pi as any, INTENT);

		expect(found).toHaveLength(1);
	});

	it("keeps both when two listeners object", async () => {
		const { pi, listen } = bus();
		for (const who of ["meteorite", "github"]) {
			listen(WORK_PUBLISH_CHECK, (raw) => {
				(raw as { object: (one: unknown) => void }).object({
					from: who,
					reason: "no",
				});
			});
		}

		// biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's bus
		const found = await objectionsTo(pi as any, INTENT);

		expect(found.map((one) => one.from)).toEqual(["meteorite", "github"]);
	});

	it("does not let a throwing listener decide whether the push happens", async () => {
		const { pi, listen } = bus();
		listen(WORK_PUBLISH_CHECK, () => {
			throw new Error("this listener is having a bad day");
		});

		// biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's bus
		await expect(objectionsTo(pi as any, INTENT)).resolves.toEqual([]);
	});

	it("does not wait forever for a listener that never answers", async () => {
		// A push that hangs looks broken. A push that goes ahead is what would
		// have happened anyway without the check.
		const { pi, listen } = bus();
		listen(WORK_PUBLISH_CHECK, (raw) => {
			(raw as { waitFor: (work: Promise<unknown>) => void }).waitFor(
				new Promise(() => {}),
			);
		});

		const started = Date.now();
		// biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's bus
		const found = await objectionsTo(pi as any, INTENT);

		expect(found).toEqual([]);
		expect(Date.now() - started).toBeLessThan(8000);
	}, 20_000);

	it("tells the listener what is about to be published", async () => {
		const seen = vi.fn();
		const { pi, listen } = bus();
		listen(WORK_PUBLISH_CHECK, (raw) => {
			seen((raw as { intent: unknown }).intent);
		});

		// biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's bus
		await objectionsTo(pi as any, INTENT);

		expect(seen).toHaveBeenCalledWith(INTENT);
	});
});
