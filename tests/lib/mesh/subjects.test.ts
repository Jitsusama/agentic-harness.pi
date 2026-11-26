/**
 * The subjects a cell declares: the owner prefixes the config names it
 * for, longest first and as written, then its quest's own list, capped
 * as mycelium's node reads them.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	declaredSubjects,
	LONGEST_SUBJECT,
	MOST_SUBJECTS,
	ownedPrefixes,
	ownerLinesAt,
	ownersFile,
	subjectsOf,
} from "../../../lib/mesh/subjects.ts";

describe("the prefixes the owner lines name a cell for", () => {
	const lines = [
		"health.=80ECO2",
		"health.agents.=85PKB2",
		"crashes:biome=85PKB2",
		"unit:pi-host-=85PKB2",
		"switch.=16V6F4",
	];

	it("keeps those naming any of its addresses, longest first, as long in the order written", () => {
		expect(ownedPrefixes(lines, ["85PKB2", "01A1ECC0"])).toEqual([
			"health.agents.",
			"crashes:biome",
			"unit:pi-host-",
		]);
	});

	it("names none for a cell no line names", () => {
		expect(ownedPrefixes(lines, ["8SBP7O"])).toEqual([]);
	});

	it("splits a line at its first equals sign, as cadence does, passing over one with none or an empty side", () => {
		expect(
			ownedPrefixes(
				["a=b=85PKB2", "plain", "=85PKB2", "gate.=", "  merge. = 85PKB2 "],
				["85PKB2", "b=85PKB2"],
			),
			"the address after the first sign, both sides trimmed",
		).toEqual(["merge.", "a"]);
	});

	it("keeps a prefix once though two lines name it", () => {
		expect(ownedPrefixes(["oom.=5FWIUS", "oom.=5FWIUS"], ["5FWIUS"])).toEqual([
			"oom.",
		]);
	});
});

describe("the subjects a quest's README declares", () => {
	it("reads a list's strings, trimmed, passing over anything else", () => {
		expect(
			declaredSubjects([" mycelium:hubs ", 7, "", "needs", { a: 1 }]),
		).toEqual(["mycelium:hubs", "needs"]);
	});

	it("reads none from anything but a list", () => {
		expect(declaredSubjects("needs")).toEqual([]);
		expect(declaredSubjects(undefined)).toEqual([]);
	});
});

describe("a cell's subjects", () => {
	it("puts the owned prefixes first, then the README's, each once", () => {
		expect(
			subjectsOf(
				["health.agents.", "unit:pi-host-"],
				["needs", "unit:pi-host-"],
			),
		).toEqual(["health.agents.", "unit:pi-host-", "needs"]);
	});

	it(`holds at most ${MOST_SUBJECTS}, as the node reads no more`, () => {
		const many = Array.from(
			{ length: MOST_SUBJECTS + 8 },
			(_, at) => `subject-${at}`,
		);
		const kept = subjectsOf(many.slice(0, 8), many.slice(8));
		expect(kept).toHaveLength(MOST_SUBJECTS);
		expect(kept.at(-1)).toBe(`subject-${MOST_SUBJECTS - 1}`);
	});

	it("passes over one too long or one a terminal would not draw as plain text, so it takes no place", () => {
		const long = "x".repeat(LONGEST_SUBJECT + 1);
		expect(
			subjectsOf(
				[
					long,
					"bad\u202eturn",
					"zero\u200bwidth",
					"var\ufe0fsel",
					"fill\u3164er",
				],
				["line\nbreak", "tab\tbed", "x".repeat(LONGEST_SUBJECT), "needs"],
			),
		).toEqual(["x".repeat(LONGEST_SUBJECT), "needs"]);
	});

	it("counts characters as the node does, a code point each, however many units one takes", () => {
		const astral = "\u{1F344}";
		expect(
			subjectsOf(
				[astral.repeat(LONGEST_SUBJECT + 1)],
				[astral.repeat(LONGEST_SUBJECT)],
			),
		).toEqual([astral.repeat(LONGEST_SUBJECT)]);
	});

	it("passes over every character the node counts unseen, at each end of its ranges", () => {
		const unseen = [
			0x00ad, 0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x200b,
			0x200d, 0x2060, 0x2065, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xe0000,
			0xe007f, 0xe0100, 0xe01ef, 0x061c, 0x200e, 0x202a, 0x2069, 0x2028, 0x2029,
		];
		const holding = unseen.map((point) => `a${String.fromCodePoint(point)}b`);
		expect(subjectsOf(holding, ["plain"])).toEqual(["plain"]);
	});

	it("passes over a surrogate standing alone, which no Rust string can hold", () => {
		expect(
			subjectsOf(["high\ud83c", "low\udf44"], ["\u{1F344}", "plain"]),
		).toEqual(["\u{1F344}", "plain"]);
	});
});

describe("the owners file", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mesh-owners-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("is cadence's owners.txt under the config folder, unless PI_OWNERS_FILE names another", () => {
		expect(ownersFile({ HOME: "/h" })).toBe("/h/.config/cadence/owners.txt");
		expect(ownersFile({ HOME: "/h", XDG_CONFIG_HOME: "/c" })).toBe(
			"/c/cadence/owners.txt",
		);
		expect(ownersFile({ HOME: "/h", PI_OWNERS_FILE: "/o/owners" })).toBe(
			"/o/owners",
		);
	});

	it("is never looked for under the folder pi started in, for an empty home or a relative config folder", () => {
		// homedir() reads the process's own HOME, so that is what is emptied.
		const saved = process.env.HOME;
		process.env.HOME = "";
		let empty: string | undefined;
		try {
			empty = ownersFile({ HOME: "" });
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
		expect(
			[
				empty,
				ownersFile({ HOME: "/h", XDG_CONFIG_HOME: "conf" }),
				ownersFile({ HOME: "/h", PI_OWNERS_FILE: "owners.txt" }),
				ownerLinesAt(undefined),
			],
			"none, the home's .config, none, no lines",
		).toEqual([undefined, "/h/.config/cadence/owners.txt", undefined, []]);
	});

	it("gives none for a folder, a pipe or a file too large to be one, so a refresh never stalls", () => {
		const folder = join(root, "folder");
		mkdirSync(folder);
		const pipe = join(root, "pipe");
		execFileSync("mkfifo", [pipe]);
		const large = join(root, "large");
		writeFileSync(large, "health.=80ECO2\n".repeat(10_000));
		expect([folder, pipe, large].map(ownerLinesAt)).toEqual([[], [], []]);
	});

	it.runIf(existsSync("/dev/zero"))(
		"gives none for a device that never ends, which only the regular-file check stops",
		() => {
			expect(ownerLinesAt("/dev/zero")).toEqual([]);
		},
	);

	it("gives its lines, and none when it is missing", () => {
		const file = join(root, "owners.txt");
		expect(ownerLinesAt(file)).toEqual([]);
		writeFileSync(file, "health.=80ECO2\n\nswitch.=16V6F4\n");
		expect(ownerLinesAt(file)).toEqual(["health.=80ECO2", "switch.=16V6F4"]);
	});

	it("gives what it says now once it is written again", () => {
		const file = join(root, "owners.txt");
		writeFileSync(file, "health.=80ECO2\n");
		expect(ownerLinesAt(file)).toEqual(["health.=80ECO2"]);
		writeFileSync(file, "switch.=16V6F4\nmerge.=Y9XISP\n");
		expect(ownerLinesAt(file)).toEqual(["switch.=16V6F4", "merge.=Y9XISP"]);
	});
});
