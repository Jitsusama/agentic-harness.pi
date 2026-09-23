import { describe, expect, it } from "vitest";
import { resolveLayered } from "../../../../lib/internal/config/resolve.ts";

describe("resolving a value across the config ladder", () => {
	it("falls back to the default when nothing is set at any layer", () => {
		const resolved = resolveLayered({}, "fallback-value");
		expect(resolved).toEqual({ value: "fallback-value", layer: "default" });
	});

	it("takes the global value when only global is set", () => {
		const resolved = resolveLayered({ global: "g" }, "fallback");
		expect(resolved).toEqual({ value: "g", layer: "global" });
	});

	it("lets project override global", () => {
		const resolved = resolveLayered({ global: "g", project: "p" }, "fallback");
		expect(resolved).toEqual({ value: "p", layer: "project" });
	});

	it("lets quest override project and global", () => {
		const resolved = resolveLayered(
			{ global: "g", project: "p", quest: "q" },
			"fallback",
		);
		expect(resolved).toEqual({ value: "q", layer: "quest" });
	});

	it("lets an explicit call-site value override every stored layer", () => {
		const resolved = resolveLayered(
			{ global: "g", project: "p", quest: "q", call: "c" },
			"fallback",
		);
		expect(resolved).toEqual({ value: "c", layer: "call" });
	});

	it("skips a layer that is present but undefined, not just an absent key", () => {
		const resolved = resolveLayered(
			{ global: "g", project: undefined, quest: undefined },
			"fallback",
		);
		expect(resolved).toEqual({ value: "g", layer: "global" });
	});

	it("treats a falsy but defined value as set, not as absent", () => {
		// A resolved thinking-level clock of 0, or a roster size of 0, is
		// a real, deliberate value, not the same thing as unset.
		const resolved = resolveLayered({ global: 5, quest: 0 }, 99);
		expect(resolved).toEqual({ value: 0, layer: "quest" });
	});
});
