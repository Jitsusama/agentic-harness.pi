/**
 * One at a time: a look on a clock passes over the ticks that come while
 * it reads, and work asked for again while it runs runs once more after.
 */
import { describe, expect, it } from "vitest";
import { coalescing, skipping } from "../../../lib/internal/one-at-a-time.ts";

/** A promise and the hand that settles it, for work a test lets end. */
function held(): { done: Promise<void>; end: () => void; fail: () => void } {
	let end = (): void => undefined;
	let fail = (): void => undefined;
	const done = new Promise<void>((resolve, reject) => {
		end = resolve;
		fail = () => reject(new Error("the disk went away"));
	});
	return { done, end, fail };
}

describe("a look that skips", () => {
	it("passes over a tick that comes while the last look still reads", async () => {
		const looks: ReturnType<typeof held>[] = [];
		const look = skipping(() => {
			const one = held();
			looks.push(one);
			return one.done;
		});

		const first = look();
		const second = look();
		expect(looks, "the second tick started nothing").toHaveLength(1);
		expect(second, "it answers the look still going").toBe(first);

		looks[0]?.end();
		await first;
		void look();
		expect(looks, "the next tick after it ended looks again").toHaveLength(2);
		looks[1]?.end();
	});

	it("looks again at the next tick after a look that failed", async () => {
		const looks: ReturnType<typeof held>[] = [];
		const look = skipping(() => {
			const one = held();
			looks.push(one);
			return one.done;
		});

		const failing = look();
		looks[0]?.fail();
		await expect(failing).rejects.toThrow("the disk went away");
		void look();
		expect(looks, "a failure frees the next tick").toHaveLength(2);
		looks[1]?.end();
	});
});

describe("work that coalesces", () => {
	it("runs once more after it ends, however many asks came while it ran", async () => {
		const runs: ReturnType<typeof held>[] = [];
		const take = coalescing(() => {
			const one = held();
			runs.push(one);
			return one.done;
		});

		const first = take();
		const asks = [take(), take(), take()];
		expect(runs, "none ran beside the first").toHaveLength(1);

		runs[0]?.end();
		await first;
		await Promise.resolve();
		expect(runs, "one more run for every ask that came meanwhile").toHaveLength(
			2,
		);
		runs[1]?.end();
		await Promise.all(asks);
		expect(runs, "and no more").toHaveLength(2);
	});

	it("answers each ask once the run that covers it has ended", async () => {
		const runs: ReturnType<typeof held>[] = [];
		const take = coalescing(() => {
			const one = held();
			runs.push(one);
			return one.done;
		});
		let covered = false;

		void take();
		const later = take().then(() => {
			covered = true;
		});
		runs[0]?.end();
		await new Promise((settle) => setImmediate(settle));
		expect(covered, "the run it came during does not cover it").toBe(false);

		runs[1]?.end();
		await later;
		expect(covered, "the run after it does").toBe(true);
	});

	it("runs again after a run that failed, and still answers its asks", async () => {
		const runs: ReturnType<typeof held>[] = [];
		const take = coalescing(() => {
			const one = held();
			runs.push(one);
			return one.done;
		});

		const failing = take();
		const after = take();
		runs[0]?.fail();
		await expect(failing).rejects.toThrow("the disk went away");
		await new Promise((settle) => setImmediate(settle));
		expect(runs, "the ask that came meanwhile still runs").toHaveLength(2);
		runs[1]?.end();
		await expect(after).resolves.toBeUndefined();
	});
});
