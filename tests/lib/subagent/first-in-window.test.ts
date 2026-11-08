/**
 * A walk every session start would repeat is done by the first
 * session in a window and by no other session in it.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstInWindow } from "../../../lib/subagent/first-in-window.ts";

const WINDOW_MS = 5 * 60_000;
/** A moment at the start of a window, so a few seconds on stay inside it. */
const OPENS = 1_000 * WINDOW_MS;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "first-in-window-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("a walk claimed for a window", () => {
	it("goes to the first session to ask in it", async () => {
		expect(
			await firstInWindow(dir, "orphans", WINDOW_MS, OPENS),
			"the first session to ask is given the walk",
		).toBe(true);
	});

	it("goes to no other session asking later in the same window", async () => {
		await firstInWindow(dir, "orphans", WINDOW_MS, OPENS);

		expect(
			await firstInWindow(dir, "orphans", WINDOW_MS, OPENS + 60_000),
			"a later session in the same window is not given the walk",
		).toBe(false);
	});

	it("goes to exactly one of the sessions asking at once", async () => {
		const answers = await Promise.all(
			Array.from({ length: 8 }, () =>
				firstInWindow(dir, "orphans", WINDOW_MS, OPENS),
			),
		);

		expect(answers.filter(Boolean)).toHaveLength(1);
	});

	it("goes to the first session again once the window has passed", async () => {
		await firstInWindow(dir, "orphans", WINDOW_MS, OPENS);

		expect(
			await firstInWindow(dir, "orphans", WINDOW_MS, OPENS + WINDOW_MS),
			"the first session in the next window is given the walk",
		).toBe(true);
	});

	it("leaves only the window it claims behind it", async () => {
		await firstInWindow(dir, "orphans", WINDOW_MS, OPENS);
		await firstInWindow(dir, "orphans", WINDOW_MS, OPENS + 3 * WINDOW_MS);

		expect(readdirSync(dir)).toHaveLength(1);
	});

	it("is claimed apart from a walk of another name", async () => {
		await firstInWindow(dir, "orphans", WINDOW_MS, OPENS);

		expect(
			await firstInWindow(dir, "sweep", WINDOW_MS, OPENS),
			"a walk of another name is given apart",
		).toBe(true);
	});

	it("goes ahead where there is no folder to claim it in", async () => {
		// Nothing has been written there yet, so the walk has nothing to
		// find either; a session refused it would only be wrong later.
		expect(
			await firstInWindow(join(dir, "missing"), "orphans", WINDOW_MS, OPENS),
			"a session with no folder to claim in is given the walk",
		).toBe(true);
	});
});
