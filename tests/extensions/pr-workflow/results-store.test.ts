/**
 * Tests for the pr-workflow parsed-results store.
 *
 * The store holds the heavy council, judge and critique run
 * bodies as flat files keyed by run id, so the session log can
 * carry only lightweight pointers. These tests assert the
 * observable round-trip and the absent-id contract through the
 * public API.
 */

import {
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResultsStore } from "../../../extensions/pr-workflow/results-store.js";

describe("ResultsStore", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pr-results-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips a run body by id", () => {
		const store = new ResultsStore(dir);
		const run = {
			id: "c-1",
			startedAt: "2026-01-01T00:00:00Z",
			payload: { findings: [1, 2, 3], note: "hello" },
		};

		store.writeRun(run);

		expect(store.readRun(run.id)).toEqual(run);
	});

	it("returns null for an absent id", () => {
		const store = new ResultsStore(dir);

		expect(store.readRun("missing")).toBeNull();
	});

	it("returns null for a corrupt body instead of throwing", () => {
		// A truncated or corrupt file (full disk during an earlier
		// write, manual editing) must degrade like a missing body
		// so restore can surface a notice rather than crash.
		const store = new ResultsStore(dir);
		store.writeRun({ id: "c-1", value: "ok" });
		const resultsDir = join(dir, "results");
		const file = readdirSync(resultsDir)[0];
		writeFileSync(join(resultsDir, file), "{ not valid json", "utf-8");

		expect(store.readRun("c-1")).toBeNull();
	});

	it("does not alias two ids that sanitize to the same segment", () => {
		// The id is a durable join key across forks, so two
		// distinct ids must never collapse onto one file even when
		// their filesystem-safe segments are identical.
		const store = new ResultsStore(dir);
		store.writeRun({ id: "run/1", value: "slash" });
		store.writeRun({ id: "run*1", value: "star" });

		expect(store.readRun("run/1")).toEqual({ id: "run/1", value: "slash" });
		expect(store.readRun("run*1")).toEqual({ id: "run*1", value: "star" });
	});

	it("overwrites an existing body for the same id", () => {
		const store = new ResultsStore(dir);
		store.writeRun({ id: "c-1", value: "first" });

		store.writeRun({ id: "c-1", value: "second" });

		expect(store.readRun("c-1")).toEqual({ id: "c-1", value: "second" });
	});

	it("prunes bodies that are both old and beyond the count cap", () => {
		const store = new ResultsStore(dir);
		for (let i = 1; i <= 4; i++) store.writeRun({ id: `old-${i}`, n: i });
		// Age every existing file well into the past.
		const resultsDir = join(dir, "results");
		const ancient = new Date("2000-01-01T00:00:00Z");
		for (const f of readdirSync(resultsDir)) {
			utimesSync(join(resultsDir, f), ancient, ancient);
		}
		store.writeRun({ id: "fresh", n: 99 });

		const summary = store.cleanup({
			maxFiles: 1,
			maxAgeMs: 60_000,
			now: new Date("2026-01-01T00:00:00Z"),
		});

		expect(summary.removed).toBe(4);
		expect(store.readRun("fresh")).toEqual({ id: "fresh", n: 99 });
		expect(store.readRun("old-1")).toBeNull();
	});

	it("keeps recent bodies even when they exceed the count cap", () => {
		// Recency protects a body that is still referenced: a fresh
		// transcript must never be pruned just because the count is
		// over the cap.
		const store = new ResultsStore(dir);
		for (let i = 1; i <= 5; i++) store.writeRun({ id: `c-${i}`, n: i });

		const summary = store.cleanup({ maxFiles: 1, maxAgeMs: 60_000 });

		expect(summary.removed).toBe(0);
		expect(store.readRun("c-1")).toEqual({ id: "c-1", n: 1 });
	});

	it("is a no-op when the results directory does not exist", () => {
		const store = new ResultsStore(dir);

		expect(store.cleanup({ maxFiles: 10, maxAgeMs: 60_000 })).toEqual({
			removed: 0,
			kept: 0,
		});
	});
});
