import { describe, expect, it } from "vitest";
import { withHiddenWorking } from "../../../extensions/pr-workflow/gate-working.js";

describe("withHiddenWorking", () => {
	it("hides the working loader while the gate is active", async () => {
		const calls: boolean[] = [];
		const result = await withHiddenWorking(
			{
				hasUI: true,
				ui: { setWorkingVisible: (visible) => calls.push(visible) },
			},
			async () => {
				expect(calls).toEqual([false]);
				return "done";
			},
		);

		expect(result).toBe("done");
		expect(calls).toEqual([false, true]);
	});

	it("restores the working loader when the gate throws", async () => {
		const calls: boolean[] = [];
		await expect(
			withHiddenWorking(
				{
					hasUI: true,
					ui: { setWorkingVisible: (visible) => calls.push(visible) },
				},
				async () => {
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");

		expect(calls).toEqual([false, true]);
	});

	it("does not touch the working loader without a UI", async () => {
		const calls: boolean[] = [];
		const result = await withHiddenWorking(
			{
				hasUI: false,
				ui: { setWorkingVisible: (visible) => calls.push(visible) },
			},
			async () => "headless",
		);

		expect(result).toBe("headless");
		expect(calls).toEqual([]);
	});
});
