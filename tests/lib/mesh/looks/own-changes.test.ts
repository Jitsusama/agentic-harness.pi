import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	carryProposed,
	keepProposed,
	keptProposed,
	namesChange,
	opensOneOf,
	ownChangesBeside,
	proposedIn,
	proposedKey,
} from "../../../../lib/mesh/looks/own-changes.ts";

const PR = "https://github.com/Jitsusama/agentic-harness.pi/pull/12";

/** A tool's answer as a session's log keeps it. */
function answered(toolName: string, details: unknown): unknown {
	return {
		type: "message",
		message: { role: "toolResult", toolName, details },
	};
}

// Joel, 24 November: "don't fucking put prs in my look list, review it
// your fucking self".
describe("a session's own changes", () => {
	it("reads what review_offer proposed, one or a stack, and nothing else", () => {
		const entries = [
			answered("review_offer", { ok: true, change: "#12", url: PR }),
			answered("review_offer", {
				ok: true,
				urls: [`${PR}3`, 7, ""],
			}),
			answered("review_see", { url: "https://github.com/o/r/pull/9" }),
			{ type: "message", message: { role: "user", content: PR } },
			"torn",
		];

		expect(proposedIn(entries)).toEqual([PR, `${PR}3`]);
	});

	it("finds a change by its tabs, diffs and comments, not by a longer number", () => {
		expect(opensOneOf(PR, [PR])).toBe(true);
		expect(opensOneOf(`${PR}/files`, [PR])).toBe(true);
		expect(opensOneOf(`${PR}#discussion_r1`, [`${PR}/`])).toBe(true);
		expect(opensOneOf(`${PR}?w=1`, [PR])).toBe(true);
		expect(opensOneOf(`${PR}3`, [PR])).toBe(false);
		expect(opensOneOf(PR, [])).toBe(false);
		expect(opensOneOf(PR, [""])).toBe(false);
	});

	it("finds a change however its URL is spelled", () => {
		const spelled = [
			`${PR}.diff`,
			`${PR}.patch`,
			"https://github.com/jitsusama/Agentic-Harness.pi/pull/12",
			"http://github.com/Jitsusama/agentic-harness.pi/pull/12",
			"https://www.github.com/Jitsusama/agentic-harness.pi/pull/12/files",
			` ${PR}/ `,
		];
		for (const target of spelled) expect(opensOneOf(target, [PR])).toBe(true);
		expect(opensOneOf(`${PR}3.diff`, [PR])).toBe(false);
		expect(opensOneOf(PR, [`${PR}.diff`])).toBe(true);
	});

	it("reads Graphite's view and GitHub's issue path of a pull request as the pull request", () => {
		const views = [
			"https://app.graphite.com/github/pr/Jitsusama/agentic-harness.pi/12",
			"https://app.graphite.dev/github/pr/jitsusama/agentic-harness.pi/12/files",
			"https://github.com/Jitsusama/agentic-harness.pi/issues/12",
		];
		for (const target of views) expect(opensOneOf(target, [PR])).toBe(true);
		expect(
			opensOneOf(
				"https://app.graphite.com/github/pr/Jitsusama/agentic-harness.pi/123",
				[PR],
			),
		).toBe(false);
		expect(
			opensOneOf(PR, [
				"https://app.graphite.com/github/pr/Jitsusama/agentic-harness.pi/12",
			]),
		).toBe(true);
	});
});

describe("the record of what a quest proposed", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true });
	});

	/** A folder of looks, in a folder of its own, to keep the record beside. */
	function records(): string {
		const top = mkdtempSync(join(tmpdir(), "own-changes-"));
		made.push(top);
		return ownChangesBeside(join(top, "looks"));
	}

	it("keeps each owner's proposals, once each, past the session that made them", () => {
		const dir = records();
		keepProposed(dir, "QEST-1", [PR]);
		keepProposed(dir, "QEST-1", [`${PR}/`, `${PR}3`]);
		keepProposed(dir, "0193-session", ["https://github.com/o/r/pull/9"]);

		expect(keptProposed(dir, ["QEST-1"]).sort()).toEqual([PR, `${PR}3`]);
		expect(keptProposed(dir, [undefined, "0193-session"])).toEqual([
			"https://github.com/o/r/pull/9",
		]);
		expect(keptProposed(dir, ["QEST-2", ""])).toEqual([]);
	});

	it("keeps every change, and an owner's id never names a folder outside the record", () => {
		const dir = records();
		const many = Array.from(
			{ length: 250 },
			(_, at) => `https://github.com/o/r/pull/${at}`,
		);
		keepProposed(dir, "../away", many);

		expect(keptProposed(dir, ["../away"]).sort()).toEqual([...many].sort());
		expect(readdirSync(dir)).toEqual(["___away"]);
	});

	// Two sessions of one quest proposing at once each write files of
	// their own, so neither rewrites what the other kept; this shows the
	// files are apart, not that two processes race.
	it("keeps each change in a file of its own, and a torn file loses only its own change", () => {
		const dir = records();
		keepProposed(dir, "QEST-1", [PR]);
		keepProposed(dir, "QEST-1", [`${PR}3`]);
		const folder = join(dir, "QEST-1");
		const [first] = readdirSync(folder).filter((name) =>
			name.endsWith(".json"),
		);
		writeFileSync(join(folder, first ?? "none.json"), "{torn");

		expect(keptProposed(dir, ["QEST-1"])).toHaveLength(1);
		keepProposed(dir, "QEST-1", [PR, `${PR}3`]);
		expect(keptProposed(dir, ["QEST-1"]).sort()).toEqual([PR, `${PR}3`]);
	});

	it("carries a session's record to the id its rollover took, past a chain of them", () => {
		const dir = records();
		keepProposed(dir, "0193-first", [PR]);
		carryProposed(dir, "0193-first", "0193-second");
		carryProposed(dir, "0193-second", "0193-third");
		carryProposed(dir, "0193-nobody", "0193-fourth");

		expect(keptProposed(dir, ["0193-third"])).toEqual([PR]);
		expect(keptProposed(dir, ["0193-fourth"])).toEqual([]);
	});

	it("carries on to a session that keeps the change already, leaving its file as it is", () => {
		const dir = records();
		keepProposed(dir, "0193-first", [PR, `${PR}3`]);
		keepProposed(dir, "0193-second", [PR.toUpperCase()]);
		const before = keptProposed(dir, ["0193-second"]);

		carryProposed(dir, "0193-first", "0193-second");
		carryProposed(dir, "0193-first", "0193-second");

		const after = keptProposed(dir, ["0193-second"]).sort();
		expect(after).toEqual([...before, `${PR}3`].sort());
	});

	// A kept prefix as wide as a host would refuse every look under it
	// for good, and nothing sweeps the record.
	it("keeps nothing that names no single change", () => {
		const dir = records();
		const wide = [
			"https://",
			"http://",
			"https://example.invalid/",
			"https://host/#/c/123",
			"https://github.com/Jitsusama",
			"not a url",
		];
		keepProposed(dir, "QEST-1", wide);

		expect(keptProposed(dir, ["QEST-1"])).toEqual([]);
		for (const url of wide) expect(namesChange(proposedKey(url))).toBe(false);
		expect(
			opensOneOf("https://github.com/Jitsusama/core.nix/pull/1", wide),
		).toBe(false);
		expect(namesChange(proposedKey("https://gerrit.example/c/123"))).toBe(true);
	});

	it("keeps the rest of the changes when one can't be written, then says so", () => {
		const dir = records();
		const stuck = `${PR}3`;
		const name = `${createHash("sha256").update(proposedKey(stuck)).digest("hex").slice(0, 32)}.json`;
		// A folder where the change's file goes makes its write fail.
		mkdirSync(join(dir, "QEST-1", name, "held"), { recursive: true });

		expect(() => keepProposed(dir, "QEST-1", [stuck, PR])).toThrow();
		expect(keptProposed(dir, ["QEST-1"])).toEqual([PR]);
		const kept = readdirSync(join(dir, "QEST-1")).find(
			(file) => file !== name && file.endsWith(".json"),
		);
		expect(readFileSync(join(dir, "QEST-1", kept ?? ""), "utf8")).toContain(PR);
	});
});
