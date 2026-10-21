import { describe, expect, it } from "vitest";
import {
	USAGE_MAX_AGE_MS,
	usageReader,
} from "../../../extensions/status-line-widget/usage.ts";

/** A reading source that counts how often it's asked. */
function counted() {
	let calls = 0;
	return {
		read: () => {
			calls += 1;
			return { tokens: calls };
		},
		calls: () => calls,
	};
}

describe("the context's usage, as the status line reads it", () => {
	it("is read once however many frames draw it", () => {
		const source = counted();
		const clock = 1000;
		const usage = usageReader(source.read, () => clock);
		for (let frame = 0; frame < 24; frame++) usage.get();
		expect(source.calls()).toBe(1);
	});

	it("is read again once the context changes", () => {
		const source = counted();
		const usage = usageReader(source.read, () => 1000);
		usage.get();
		usage.stale();
		expect(usage.get()).toEqual({ tokens: 2 });
		expect(source.calls()).toBe(2);
	});

	it("is read again once it's older than its limit, if nothing said so", () => {
		const source = counted();
		let clock = 1000;
		const usage = usageReader(source.read, () => clock);
		usage.get();
		clock += USAGE_MAX_AGE_MS - 1;
		usage.get();
		expect(source.calls()).toBe(1);
		clock += 1;
		usage.get();
		expect(source.calls()).toBe(2);
	});

	it("keeps no reading at all until it's first drawn", () => {
		const source = counted();
		usageReader(source.read, () => 1000);
		expect(source.calls()).toBe(0);
	});
});
