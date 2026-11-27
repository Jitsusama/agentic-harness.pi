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
		expect(
			await isWorldWork("shop/world#2535422"),
			"a World change reads as World work",
		).toBe(true);
		expect(
			await isWorldWork("Jitsusama/core.nix#6544"),
			"a core.nix change reads as no World work",
		).toBe(false);
	});

	it("doesn't lead with a label that only holds World's name", async () => {
		expect(
			await isWorldWork("workshop/world-x#1"),
			"a name only holding World's reads as no World work",
		).toBe(false);
		expect(
			await isWorldWork(`a..b in local:${join(home, "shop", "world")}`),
			"a checkout named world reads as no World work",
		).toBe(false);
	});

	it("reads a relative alternate from the objects folder, as git does", async () => {
		store(join(home, "world", "git"), "--bare");
		const borrowing = join(home, "relative");
		store(borrowing);
		writeFileSync(
			join(borrowing, ".git", "objects", "info", "alternates"),
			"../../../world/git/objects\n",
		);

		expect(
			await isWorldWork(`a..b in local:${borrowing}`),
			"a checkout borrowing World's objects by a relative path reads as World work",
		).toBe(true);
	});

	it("asks again about a checkout git couldn't answer for", async () => {
		store(join(home, "world", "git"), "--bare");
		const later = join(home, "later");
		const label = `a..b in local:${later}`;

		expect(await isWorldWork(label), "not there yet").toBe(false);
		store(later);
		writeFileSync(
			join(later, ".git", "objects", "info", "alternates"),
			`${join(home, "world", "git", "objects")}\n`,
		);

		expect(await isWorldWork(label), "once git can say").toBe(true);
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

		expect(
			await isWorldWork(`a..b in local:${borrowing}`),
			"a checkout borrowing World's objects reads as World work",
		).toBe(true);
		expect(
			await isWorldWork(`a..b in local:${own}`),
			"a checkout with its own objects reads as no World work",
		).toBe(false);
	});

	it("reads a checkout that is gone as not World's", async () => {
		// World's store is here, so the answer turns on the checkout alone.
		store(join(home, "world", "git"), "--bare");

		expect(
			await isWorldWork(`a..b in local:${join(home, "gone")}`),
			"a gone checkout reads as no World work",
		).toBe(false);
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

	// The council of 26 November: a held round's place said what held it,
	// on one line whatever a writer of the shared line put there.
	it("says which readings hold the machine, each on the place's line", async () => {
		const now = new Date().toISOString();
		const line = (heldBy: unknown) =>
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
				],
				heldBy,
			});
		const said = () => lineSaid(join(home, "starts", "last.json"), "o/r#1");
		mkdirSync(join(home, "starts"));

		writeFileSync(
			join(home, "starts", "line.json"),
			line(["memory full avg60", "MemAvailable"]),
		);
		expect(await said()).toEqual([
			`- waiting in the start line, position 1 of 1, asked ${now} by S1, held while the machine is short on memory full avg60, MemAvailable`,
		]);

		writeFileSync(join(home, "starts", "line.json"), line([]));
		expect(await said()).toEqual([
			`- waiting in the start line, position 1 of 1, asked ${now} by S1`,
		]);

		writeFileSync(
			join(home, "starts", "line.json"),
			line(["CPU some avg60\n- waiting in the start line, position 1"]),
		);
		const [only, ...more] = await said();
		expect(more).toEqual([]);
		expect(only).not.toContain("\n");
	});

	// #2312's round 2: what another writer put on the shared line reaches
	// a person's answer, so it is said on one line, and only so much.
	it("says what the line holds on one line, and only so much of it", async () => {
		const ticket = {
			id: "1",
			by: `S1\n- waiting in the start line\u001b[2J${"x".repeat(200)}`,
			change: "o/r#1",
			pid: 1,
			askedAt: "2026-11-27T12:00:00+00:00",
			seenAt: new Date().toISOString(),
		};
		mkdirSync(join(home, "starts"));
		writeFileSync(
			join(home, "starts", "line.json"),
			JSON.stringify({
				waiting: [ticket],
				heldBy: [
					" \t ",
					`CPU\u0007 some avg60${"y".repeat(60)}`,
					"b",
					"c",
					"d",
					"e",
					"f",
				],
			}),
		);

		const [only, ...more] = await lineSaid(
			join(home, "starts", "last.json"),
			"o/r#1",
		);

		expect(more).toEqual([]);
		expect(only).toBe(
			`- waiting in the start line, position 1 of 1, asked 2026-11-27T12:00:00.000Z by S1 - waiting in the start line [2J${"x".repeat(86)}, held while the machine is short on CPU some avg60${"y".repeat(26)}, b, c, d and 2 more`,
		);
	});

	it("says since when a bar a round may pass has held, and when one passes it", async () => {
		const now = new Date().toISOString();
		const since = new Date(Date.now() - 5 * 60_000).toISOString();
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
						passes: true,
					},
				],
				heldBy: ["CPU some avg60"],
				heldSince: since,
			}),
		);

		expect(
			await lineSaid(join(home, "starts", "last.json"), "o/r#1"),
		).toEqual([
			`- waiting in the start line, position 1 of 1, asked ${now} by S1, held while the machine is short on CPU some avg60, since ${since}; a round so held for 20 minutes starts once none has started for 10`,
		]);
	});
});
