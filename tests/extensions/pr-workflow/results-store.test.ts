/**
 * Tests for the pr-workflow parsed-results store.
 *
 * The store holds the heavy council, judge and critique run
 * bodies as flat files keyed by run id, so the session log can
 * carry only lightweight pointers. These tests assert the
 * observable round-trip and the absent-id contract through the
 * public API.
 */

import { mkdtempSync, rmSync } from "node:fs";
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

	it("overwrites an existing body for the same id", () => {
		const store = new ResultsStore(dir);
		store.writeRun({ id: "c-1", value: "first" });

		store.writeRun({ id: "c-1", value: "second" });

		expect(store.readRun("c-1")).toEqual({ id: "c-1", value: "second" });
	});
});
