import { describe, expect, it } from "vitest";

/**
 * Sentinel for the vitest harness itself: proves the runner
 * boots, picks up tests under `tests/`, and can import code
 * from the package's exported library subpaths.
 *
 * Real specs live alongside the modules they exercise under
 * `tests/lib/...` or `tests/extensions/...`.
 */
describe("test harness", () => {
	it("runs", () => {
		expect(true).toBe(true);
	});

	it("loads ESM modules", async () => {
		const ui = await import("../lib/ui/text-layout.js");
		expect(typeof ui.wordWrap).toBe("function");
	});
});
