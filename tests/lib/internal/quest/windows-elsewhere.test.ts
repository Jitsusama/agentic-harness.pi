/**
 * The windows here joined to a session another machine holds, and what
 * the boot after offers back of them.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ElsewhereWindow,
	nextNote,
	readWindowsNote,
	windowsElsewhere,
	windowsToReopen,
	writeWindowsNote,
} from "../../../../lib/internal/quest/windows-elsewhere";

const MAC_ATTACH = [
	"ssh",
	"-t",
	"equilibrius",
	"mycelium",
	"attach",
	"9f2c1a07",
];
const LOCAL_ATTACH = ["mycelium", "--realm", "work", "attach", "603b1c53"];

/** The node's Sessions answer, as `mycelium sessions` prints it. */
const sessions = {
	Ok: {
		Sessions: [
			{
				id: "01a19000-0000-7000-8000-00000000mac1",
				address: "SAK9FZ",
				machine: "equilibrius",
				title: "π - Steer Across Machines",
				quest: "QEST-20261029-SAK9FZ",
				held: "9f2c1a07",
				attach: MAC_ATTACH,
			},
			{
				id: "01a17858-f49a-7339-b39c-e82ddb30d155",
				address: "WCJQSG",
				machine: "optimus",
				title: "π - Optimus - dotfiles",
				quest: "QEST-20261007-WCJQSG",
				held: "603b1c53",
				attach: LOCAL_ATTACH,
			},
			{ id: "unheld", address: "N10TYF", machine: "equilibrius", title: "x" },
		],
	},
};

/** A kitty `ls` answer with one window running each of these. */
const kitty = (...running: string[][]) => [
	{
		tabs: [
			{
				windows: running.map((cmdline, i) => ({
					id: i + 1,
					cwd: "/home/someone",
					foreground_processes: [
						{ cmdline, pid: 100 + i, cwd: "/home/someone" },
					],
				})),
			},
		],
	},
];

const macWindow: ElsewhereWindow = {
	id: "01a19000-0000-7000-8000-00000000mac1",
	address: "SAK9FZ",
	title: "π - Steer Across Machines",
	quest: "QEST-20261029-SAK9FZ",
	machine: "equilibrius",
	attach: MAC_ATTACH,
	cwd: "/home/someone",
};

describe("the windows joined to another machine's session", () => {
	it("notes a window whose foreground command is that session's attach", () => {
		expect(windowsElsewhere([kitty(MAC_ATTACH)], sessions, "optimus")).toEqual([
			macWindow,
		]);
	});

	it("leaves out a session this machine holds, and windows at a shell", () => {
		const answer = kitty(
			LOCAL_ATTACH,
			["/run/current-system/sw/bin/zsh"],
			["pi"],
		);
		expect(windowsElsewhere([answer], sessions, "optimus")).toEqual([]);
	});

	it("needs the attach word for word, not a near one", () => {
		const typed = ["ssh", "equilibrius", "mycelium", "attach", "9f2c1a07"];
		expect(windowsElsewhere([kitty(typed)], sessions, "optimus")).toEqual([]);
	});

	it("notes a session once however many windows show it", () => {
		const both = [kitty(MAC_ATTACH), kitty(MAC_ATTACH)];
		expect(windowsElsewhere(both, sessions, "optimus")).toHaveLength(1);
	});

	it("notes nothing from answers it can't read", () => {
		expect(windowsElsewhere([undefined, "no"], undefined, "optimus")).toEqual(
			[],
		);
		expect(
			windowsElsewhere([kitty(MAC_ATTACH)], { Err: "no node" }, "optimus"),
		).toEqual([]);
	});
});

describe("what the boot after offers back", () => {
	const ended = nextNote(undefined, "boot-before", [macWindow]);

	it("is the note's own windows until this boot first writes it", () => {
		expect(windowsToReopen(ended, "boot-now", "boot-before")).toEqual({
			boot: "boot-before",
			windows: [macWindow],
		});
	});

	it("keeps the boot before's windows once this boot writes its own", () => {
		const written = nextNote(ended, "boot-now", []);
		expect(written.ended).toEqual({
			boot: "boot-before",
			windows: [macWindow],
		});
		expect(
			windowsToReopen(written, "boot-now", "boot-before")?.windows,
		).toEqual([macWindow]);
		// And a second write this boot doesn't lose them.
		expect(nextNote(written, "boot-now", []).ended?.boot).toBe("boot-before");
	});

	it("leaves out a session joined again in a window now", () => {
		const rejoined = nextNote(ended, "boot-now", [macWindow]);
		expect(
			windowsToReopen(rejoined, "boot-now", "boot-before")?.windows,
		).toEqual([]);
	});

	it("offers nothing from a note older than the boot that just ended", () => {
		expect(windowsToReopen(ended, "boot-now", "a-later-boot")).toBeUndefined();
	});
});

describe("the note on disk", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "windows-elsewhere-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads back what it wrote, and is written only when it changes", () => {
		const path = join(dir, "state", "windows-elsewhere.json");
		const note = nextNote(undefined, "boot-now", [macWindow]);

		expect(writeWindowsNote(path, note)).toBe(true);
		expect(readWindowsNote(path)).toEqual(note);
		expect(writeWindowsNote(path, note)).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8")).v).toBe(1);
	});

	it("reads a missing or foreign file as no note", () => {
		expect(readWindowsNote(join(dir, "none.json"))).toBeUndefined();
	});
});
