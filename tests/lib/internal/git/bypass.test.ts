import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isGitBypassed,
	setGitBypassed,
} from "../../../../lib/internal/git/bypass.js";

// The bypass lives on a Symbol.for slot on globalThis, so it
// persists across tests. Reset it around each test to keep them
// independent.
beforeEach(() => setGitBypassed(false));
afterEach(() => setGitBypassed(false));

describe("git bypass state", () => {
	it("is not bypassed by default", () => {
		expect(isGitBypassed()).toBe(false);
	});

	it("round-trips through set and clear", () => {
		setGitBypassed(true);
		expect(isGitBypassed()).toBe(true);
		setGitBypassed(false);
		expect(isGitBypassed()).toBe(false);
	});

	it("stores state on the shared global slot so any importer sees it", () => {
		// The state lives on globalThis under Symbol.for, which is the
		// whole point: the toggle and the interceptors load as separate
		// extensions and must observe one shared value. Reading the slot
		// directly proves a second importer resolves the same state.
		const slot = globalThis as Record<symbol, boolean | undefined>;
		setGitBypassed(true);
		expect(slot[Symbol.for("pi:git-bypass")]).toBe(true);
		setGitBypassed(false);
		expect(slot[Symbol.for("pi:git-bypass")]).toBe(false);
	});
});
