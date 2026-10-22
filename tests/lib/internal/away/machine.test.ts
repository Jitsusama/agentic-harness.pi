/**
 * The machine's word on whether the person is away: written whole,
 * read back as written, watched, and agreed with only when it is the
 * newer word.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agree,
	publishMachineWord,
	readMachineWord,
	watchMachineWord,
} from "../../../../lib/internal/away/machine.ts";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "away-machine-"));
	path = join(dir, "away", "machine.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("the machine's word", () => {
	it("reads back an absence as it was written", () => {
		publishMachineWord(
			{ since: "2026-10-22T03:15:00.000Z", goal: "overnight" },
			new Date("2026-10-22T03:15:01.000Z"),
			path,
		);

		expect(readMachineWord(path)).toEqual({
			away: { since: "2026-10-22T03:15:00.000Z", goal: "overnight" },
			at: "2026-10-22T03:15:01.000Z",
		});
	});

	it("reads back the person being here", () => {
		publishMachineWord(undefined, new Date("2026-10-22T12:00:00.000Z"), path);

		expect(readMachineWord(path)).toEqual({ at: "2026-10-22T12:00:00.000Z" });
	});

	it("says nothing when the file is missing or unreadable", () => {
		expect(readMachineWord(path)).toBeUndefined();
		publishMachineWord(undefined, new Date(), path);
		writeFileSync(path, "{ half a wo");

		expect(readMachineWord(path)).toBeUndefined();
	});

	it("tells a watcher when another session writes it", async () => {
		const seen = vi.fn();
		const stop = watchMachineWord(seen, path);
		try {
			publishMachineWord(
				{ since: "2026-10-22T03:15:00.000Z" },
				new Date(),
				path,
			);

			await vi.waitFor(() =>
				expect(seen).toHaveBeenCalledWith(
					expect.objectContaining({
						away: { since: "2026-10-22T03:15:00.000Z" },
					}),
				),
			);
		} finally {
			stop();
		}
	});
});

describe("agreeing with the machine", () => {
	const since = "2026-10-22T03:15:00.000Z";

	it("goes away when the machine says the person left", () => {
		expect(agree({ away: { since, goal: "x" }, at: since }, {})).toEqual({
			kind: "go-away",
			since,
			goal: "x",
		});
	});

	it("takes a new goal into an absence already under way", () => {
		expect(
			agree(
				{ away: { since, goal: "new" }, at: since },
				{ since, goal: "old" },
			),
		).toMatchObject({ kind: "go-away", goal: "new" });
	});

	it("comes back on a word written after the absence began", () => {
		expect(agree({ at: "2026-10-22T12:00:00.000Z" }, { since })).toEqual({
			kind: "come-back",
		});
	});

	it("keeps an absence that began after the person last typed", () => {
		expect(agree({ at: "2026-10-22T01:00:00.000Z" }, { since })).toEqual({
			kind: "nothing",
		});
	});

	it("leaves the session as it is when the machine says nothing", () => {
		expect(agree(undefined, { since })).toEqual({ kind: "nothing" });
		expect(agree(undefined, {})).toEqual({ kind: "nothing" });
	});
});
