/**
 * The registry's memory of sessions that have gone.
 *
 * Only the bookkeeping is exercised here. Opening a session
 * launches a real browser, so the paths that need one are covered
 * by driving the tools rather than from a unit test.
 */

import { describe, expect, it } from "vitest";
import { createSessionRegistry } from "../../../extensions/browser-integration/registry.js";

describe("what the registry remembers", () => {
	it("knows nothing about a name never used", () => {
		const registry = createSessionRegistry();
		expect(registry.has("nope")).toBe(false);
		expect(registry.departureOf("nope")).toBeUndefined();
	});

	it("reports nothing to close for a name never used", async () => {
		const registry = createSessionRegistry();
		await expect(registry.close("nope")).resolves.toBe(false);
	});

	it("does not invent a departure for a failed close", async () => {
		// Nothing was open, so nothing departed: a caller closing a
		// name twice must not be told it lapsed.
		const registry = createSessionRegistry();
		await registry.close("nope");
		expect(registry.departureOf("nope")).toBeUndefined();
	});
});
