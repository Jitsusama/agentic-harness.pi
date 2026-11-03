/**
 * What the Google tools cost a start that never uses them: Google's
 * auth library is not loaded with them. It took 107 to 179 ms of every
 * pi start on 3 November, and most sessions never call Google.
 */
import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => new Set<string>());

vi.mock("google-auth-library", async (original) => {
	loaded.add("google-auth-library");
	return original();
});

describe("the Google tools", () => {
	it("load Google's auth library only once a call needs it", async () => {
		await import("../../../extensions/google-workspace-integration/index.ts");

		expect([...loaded]).toEqual([]);
	});
});
