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

/**
 * A first import of the whole extension, transformed cold: on penelope's
 * full run, 991 files beside it, it passed 5 s (8 November). What this
 * test holds is what loads, not how fast, so it waits for the import.
 */
const COLD_IMPORT_MS = 60_000;

describe("the Google tools", () => {
	it(
		"load Google's auth library only once a call needs it",
		async () => {
			await import("../../../extensions/google-workspace-integration/index.ts");

			expect([...loaded]).toEqual([]);
		},
		COLD_IMPORT_MS,
	);
});
