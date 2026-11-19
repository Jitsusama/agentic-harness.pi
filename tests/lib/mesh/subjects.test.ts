/**
 * The subjects a cell declares: the owner prefixes the config names it
 * for, longest first and as written, then its quest's own list, capped
 * as mycelium's node reads them.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	it("keeps those naming any of its addresses, longest first, each as written", () => {
		expect(ownedPrefixes(lines, ["85PKB2", "01A1ECC0"])).toEqual([
			"health.agents.",
			"unit:pi-host-",
			"crashes:biome",
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
		expect(ownedPrefixes(["oom.=5FWIUS", "oom.=5FWIUS"], ["5FWIUS"])).toEqual(
			["oom."],
		);
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
			subjectsOf(["health.agents.", "unit:pi-host-"], ["needs", "unit:pi-host-"]),
		).toEqual(["health.agents.", "unit:pi-host-", "needs"]);
	});

	it(`holds at most ${MOST_SUBJECTS}, as the node reads no more`, () => {
		const many = Array.from({ length: 20 }, (_, at) => `subject-${at}`);
		const kept = subjectsOf(many.slice(0, 8), many.slice(8));
		expect(kept).toHaveLength(MOST_SUBJECTS);
		expect(kept.at(-1)).toBe(`subject-${MOST_SUBJECTS - 1}`);
	});

	it("passes over one too long or one a terminal would not draw as plain text, so it takes no place", () => {
		const long = "x".repeat(LONGEST_SUBJECT + 1);
		expect(
			subjectsOf(
				[long, "bad\u202eturn", "zero\u200bwidth"],
				["line\nbreak", "tab\tbed", "x".repeat(LONGEST_SUBJECT), "needs"],
			),
		).toEqual(["x".repeat(LONGEST_SUBJECT), "needs"]);
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
