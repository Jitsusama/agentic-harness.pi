/**
 * What this machine tells the council start line: which rounds lead, as
 * World's do, which are marked urgent, and where a change's rounds stand.
 *
 * World's changes lead the line (1OGSE7, 25 November), and a local range
 * is World work when its checkout keeps or borrows World's objects, which
 * only git can say; a label can't.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isWorldWork,
	lineSaid,
	urgentMarks,
} from "../../../../extensions/review-integration/tools/ask-line.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "start-line-marks-"));
	vi.stubEnv("HOME", home);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

/** A git store at `path`, initialised quietly. */
function store(path: string, ...extra: string[]): void {
	mkdirSync(path, { recursive: true });
	execFileSync("git", ["init", "-q", ...extra, path]);
}

describe("which rounds lead the start line", () => {
	it("leads with a change World hosts", async () => {
		expect(await isWorldWork("shop/world#2535422")).toBe(true);
		expect(await isWorldWork("Jitsusama/core.nix#6544")).toBe(false);
	});

	it("leads with a local range whose checkout borrows World's objects", async () => {
		store(join(home, "world", "git"), "--bare");
		const borrowing = join(home, "borrowing");
		store(borrowing);
		writeFileSync(
			join(borrowing, ".git", "objects", "info", "alternates"),
			`${join(home, "world", "git", "objects")}\n`,
		);
		const own = join(home, "own");
		store(own);

		expect(await isWorldWork(`a..b in local:${borrowing}`)).toBe(true);
		expect(await isWorldWork(`a..b in local:${own}`)).toBe(false);
	});

	it("reads a checkout that is gone as not World's", async () => {
		expect(await isWorldWork(`a..b in local:${join(home, "gone")}`)).toBe(
			false,
		);
	});
});

describe("which rounds are marked urgent", () => {
	it("reads marks from beside the line and the runtime folder, past comments", async () => {
		const runtime = join(home, "run");
		mkdirSync(runtime);
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		const line = join(home, "starts", "last.json");
		mkdirSync(join(home, "starts"));
		writeFileSync(
			join(home, "starts", "urgent"),
			"# kept over a reboot\nJitsusama/agentic-harness.pi#2199  # the runtime bump\n\n",
		);
		writeFileSync(join(runtime, "council-urgent"), "f6814932-ticket\n");

		expect(await urgentMarks(line)).toEqual([
			"Jitsusama/agentic-harness.pi#2199",
			"f6814932-ticket",
		]);
	});

	it("marks nothing when no file is kept", async () => {
		vi.stubEnv("XDG_RUNTIME_DIR", join(home, "nowhere"));

		expect(await urgentMarks(join(home, "starts", "last.json"))).toEqual([]);
	});
});

describe("where a change's rounds stand", () => {
	it("says each waiting round's position", async () => {
		const now = new Date().toISOString();
		mkdirSync(join(home, "starts"));
		writeFileSync(
			join(home, "starts", "line.json"),
			JSON.stringify({
				waiting: [
					{
						id: "1",
						by: "S1",
						change: "o/r#1",
						pid: 1,
						askedAt: now,
						seenAt: now,
					},
					{
						id: "2",
						by: "S2",
						change: "o/r#2",
						pid: 2,
						askedAt: now,
						seenAt: now,
					},
				],
			}),
		);

		expect(await lineSaid(join(home, "starts", "last.json"), "o/r#2")).toEqual([
			`- waiting in the start line, position 2 of 2, asked ${now} by S2`,
		]);
	});
});
