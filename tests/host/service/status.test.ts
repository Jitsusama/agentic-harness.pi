/** What a host says of itself in words, for systemd and the journal. */

import { describe, expect, it } from "vitest";
import {
	describeStep,
	droppedNames,
	failedStartLine,
	firstLine,
	phaseTimes,
	readyCount,
	readyStatus,
	startLine,
	stoppingStatus,
} from "../../../host/service/status.ts";

describe("describeStep", () => {
	it("names the last host waited on, the engine, and which conversation of how many", () => {
		expect(describeStep({ step: "roster", holder: 41 })).toBe(
			"waiting on the last host, pid 41, to let go of the roster",
		);
		expect(describeStep({ step: "engine" })).toBe("building the engine");
		expect(
			describeStep({ step: "resume", number: 2, of: 5, sessionId: "s" }),
		).toBe("resuming 2 of 5: s");
	});
});

describe("readyStatus", () => {
	it("says how many it loaded, left parked and dropped, and any held but not resumed", () => {
		const none = { loaded: 0, parked: 0, dropped: 0, unresumed: 0 };
		expect(readyStatus(none)).toBe("ready: loaded 0, parked 0, dropped 0");
		const some = { loaded: 3, parked: 2, dropped: 32, unresumed: 1 };
		expect(readyStatus(some)).toBe(
			"ready: loaded 3, parked 2, dropped 32, 1 held but not resumed",
		);
	});

	it("says how many run in processes of their own, when any do", () => {
		const apart = { loaded: 1, parked: 2, dropped: 0, unresumed: 0 };
		expect(readyStatus({ ...apart, children: 4 })).toBe(
			"ready: loaded 1, parked 2, 4 in processes of their own, dropped 0",
		);
		expect(readyStatus({ ...apart, children: 0 })).toBe(
			"ready: loaded 1, parked 2, dropped 0",
		);
	});
});

describe("stoppingStatus", () => {
	it("says how many it parks, in words for none, one and more", () => {
		expect(stoppingStatus(0)).toBe("stopping, parking no conversations");
		expect(stoppingStatus(1)).toBe("stopping, parking 1 conversation");
		expect(stoppingStatus(2)).toBe("stopping, parking 2 conversations");
	});
});

describe("readyCount", () => {
	it("counts a resume that failed once it registered as not resumed, never as parked", () => {
		const since = "2026-11-17T05:07:00.000Z";
		const count = readyCount({
			held: () => [
				{ id: "awake", state: "idle", since },
				{ id: "asleep", state: "parked", since },
				{ id: "failed", state: "parked", since },
			],
			unresumed: [{ sessionId: "failed", reason: new Error("no") }],
			dropped: ["gone"],
			resting: () => 2,
			stillUnresumed: () => 1,
		});
		expect(count).toEqual({
			loaded: 1,
			parked: 3,
			dropped: 1,
			unresumed: 1,
			children: 0,
		});
	});

	it("counts the conversations children run apart from those the host runs", () => {
		const count = readyCount({
			held: () => [],
			unresumed: [],
			dropped: [],
			resting: () => 0,
			stillUnresumed: () => 0,
			inChildren: () => 3,
		});
		expect(count).toMatchObject({ loaded: 0, parked: 0, children: 3 });
	});
});

describe("droppedNames", () => {
	it("names the holds a start dropped, for the journal, and nothing when none", () => {
		expect(droppedNames([])).toBe("");
		expect(droppedNames(["a", "b"])).toBe(
			" (dropped, their session files gone: a, b)",
		);
	});
});

describe("phaseTimes", () => {
	it("puts each phase's time in words, and what followed the last", () => {
		expect(
			phaseTimes(
				1_000,
				[
					{ phase: "ask", at: 1_000 },
					{ phase: "gate", at: 1_100 },
					{ phase: "recovery", at: 3_600 },
				],
				65_000,
			),
		).toBe(" (ask 0.0 s, gate 0.1 s, recovery 2.5 s, rest 61.4 s)");
		expect(phaseTimes(1_000, [], 2_000), "none marked").toBe("");
	});
});

describe("startLine", () => {
	const id = "01a209c3-fefb-760c-8962-a4ae65735570";

	it("says how long an open took, and each phase, under its address and id", () => {
		expect(
			startLine(
				id,
				{ op: "open", cwd: "/work" },
				1_000,
				[
					{ phase: "prepare", at: 1_200 },
					{ phase: "services", at: 6_200 },
				],
				9_000,
			),
		).toBe(
			`65735570 (${id}): its open took 8.0 s (prepare 0.2 s, services 5.0 s, rest 2.8 s)`,
		);
	});

	// F55: what it was asked for tells one failed request from another.
	it("says one that failed before pi named it by where it was asked to open or what to adopt", () => {
		expect(
			[
				startLine(
					undefined,
					{ op: "adopt", sessionFile: "/s/one.jsonl" },
					1_000,
					[],
					1_500,
				),
				startLine(undefined, { op: "open", cwd: "/work" }, 1_000, [], 1_500),
			],
			"each names what it was asked for",
		).toEqual([
			'A conversation not yet named, adopted from "/s/one.jsonl": its adopt took 0.5 s',
			'A conversation not yet named, opening in "/work": its open took 0.5 s',
		]);
	});

	// F31: a path is quoted, so its tail can't pass for the line's own words.
	it("quotes a path, and a quote inside it", () => {
		expect(
			startLine(
				undefined,
				{ op: "open", cwd: '/w": its open took 0.1 s' },
				1_000,
				[],
				1_500,
			),
		).toBe(
			'A conversation not yet named, opening in "/w\\": its open took 0.1 s": its open took 0.5 s',
		);
	});

	// F39: a path a requester names keeps the journal entry on one line.
	it("escapes what a path holds that would break its line", () => {
		expect(
			startLine(
				undefined,
				{ op: "open", cwd: "/work\npi-host: forged\r\tx" },
				1_000,
				[],
				1_500,
			),
		).toBe(
			'A conversation not yet named, opening in "/work\\npi-host: forged\\r\\tx": its open took 0.5 s',
		);
	});

	// F20: DEL and the C1 controls, which JSON leaves raw, are escaped too.
	it("escapes DEL, the C1 controls and a terminal's escape in a path", () => {
		expect(
			startLine(
				undefined,
				{ op: "adopt", sessionFile: "/s/\u001b[2J\u007f\u0085\u009b.jsonl" },
				1_000,
				[],
				1_500,
			),
		).toBe(
			'A conversation not yet named, adopted from "/s/\\u001b[2J\\u007f\\u0085\\u009b.jsonl": its adopt took 0.5 s',
		);
	});

	// F115: what reorders or hides the text around it, or ends a line
	// outside the controls, is escaped as a control is.
	it("escapes bidi marks, zero widths and line separators in a path", () => {
		expect(
			startLine(
				undefined,
				{
					op: "open",
					cwd: "/w/\u202egpj.exe\u200b\u2028x\u2029\u{e0041}",
				},
				1_000,
				[],
				1_500,
			),
		).toBe(
			'A conversation not yet named, opening in "/w/\\u202egpj.exe\\u200b\\u2028x\\u2029\\u{e0041}": its open took 0.5 s',
		);
	});

	// F28: what draws as nothing without being a format character, a
	// combining grapheme joiner and a Hangul filler, is escaped too.
	it("escapes what draws as nothing outside the format characters", () => {
		expect(
			startLine(
				undefined,
				{ op: "open", cwd: "/w/a\u034fb\u3164c" },
				1_000,
				[],
				1_500,
			),
		).toBe(
			'A conversation not yet named, opening in "/w/a\\u034fb\\u3164c": its open took 0.5 s',
		);
	});

	// F27: a surrogate left unpaired, which UTF-8 can't hold, is escaped.
	it("escapes an unpaired surrogate in a path", () => {
		expect(
			startLine(
				undefined,
				{ op: "open", cwd: "/w/\ud800x\udfff" },
				1_000,
				[],
				1_500,
			),
		).toBe(
			'A conversation not yet named, opening in "/w/\\ud800x\\udfff": its open took 0.5 s',
		);
	});

	// F116: a backslash is doubled, so written text never reads as an escape.
	it("tells a path holding a backslash and n from one holding a newline", () => {
		const written = (cwd: string) =>
			startLine(undefined, { op: "open", cwd }, 1_000, [], 1_500);

		expect(written("/w\\n")).toBe(
			'A conversation not yet named, opening in "/w\\\\n": its open took 0.5 s',
		);
		expect(written("/w\\n")).not.toBe(written("/w\n"));
	});

	// F25: an adopted conversation's id comes from a file the requester names.
	// F47: its address, the id's last eight characters, is escaped too.
	it("escapes a named conversation's id, and the address made from it", () => {
		expect(
			startLine("id\u001bx\nyz", { op: "open", cwd: "/w" }, 1_000, [], 1_500),
		).toBe('ID\\u001bX\\nYZ ("id\\u001bx\\nyz"): its open took 0.5 s');
	});

	// F13 on #2107: backslashes are doubled before quotes are escaped, so a
	// path ending on a backslash can't close its quote early.
	it("keeps a path's backslash before a quote from closing the quote", () => {
		expect(
			startLine(
				undefined,
				{ op: "open", cwd: '/w\\": its open took 0.1 s' },
				1_000,
				[],
				1_500,
			),
		).toBe(
			'A conversation not yet named, opening in "/w\\\\\\": its open took 0.1 s": its open took 0.5 s',
		);
	});

	// F8 on #2107: a look-alike and a paired astral character pass as they are.
	it("passes a look-alike letter and a paired astral character as they are", () => {
		expect(
			startLine(
				undefined,
				{ op: "open", cwd: "/w/\u0430\u{1f600}" },
				1_000,
				[],
				1_500,
			),
		).toBe(
			'A conversation not yet named, opening in "/w/\u0430\u{1f600}": its open took 0.5 s',
		);
	});

	// F2 on #2107: journald splits a line past its LineMax, so a requester's
	// words are cut, and the line says how many it left out.
	it("cuts a long path and a long adopted id, saying how much went", () => {
		const long = `/${"\u{1f600}".repeat(600)}`;
		const kept = `/${"\u{1f600}".repeat(499)}`;

		expect(
			startLine(undefined, { op: "open", cwd: long }, 1_000, [], 1_500),
		).toBe(
			`A conversation not yet named, opening in "${kept}", cut after 500 of its 601 characters: its open took 0.5 s`,
		);
		expect(
			startLine("a".repeat(510), { op: "open", cwd: "/w" }, 1_000, [], 1_500),
		).toBe(
			`AAAAAAAA (${"a".repeat(500)}, cut after 500 of its 510 characters): its open took 0.5 s`,
		);
	});

	// An adopted id comes from the requester's file, so one that isn't an
	// id as pi makes one is quoted, and can't close the parentheses.
	it("quotes an adopted id that isn't plain, and leaves a plain one bare", () => {
		const forged = startLine(
			'x): its adopt took 0.1 s, said "',
			{ op: "adopt", sessionFile: "/w/s.jsonl" },
			1_000,
			[],
			1_500,
		);

		expect(forged).toContain(
			'("x): its adopt took 0.1 s, said \\""): its adopt took 0.5 s',
		);
		expect(
			startLine(
				"0193-ab_c.d",
				{ op: "adopt", sessionFile: "/w/s.jsonl" },
				1_000,
				[],
				1_500,
			),
		).toMatch(/ \(0193-ab_c\.d\): its adopt took 0\.5 s$/u);
	});
});

describe("failedStartLine", () => {
	// F1 on #2107: the reason most often repeats the path, so it is quoted
	// and escaped as the path is, backslashes doubled.
	it("quotes why a start failed, escaped as its path is", () => {
		expect(
			failedStartLine(
				undefined,
				{ op: "open", cwd: '/w\\"' },
				1_000,
				[],
				1_500,
				new Error(`ENOENT: chdir '/w\\": its open took 0.1 s'\nat x`),
			),
		).toBe(
			`A conversation not yet named, opening in "/w\\\\\\"": its open took 0.5 s, failing: "ENOENT: chdir '/w\\\\\\": its open took 0.1 s'"`,
		);
	});

	it("says a start that failed with no reason", () => {
		expect(
			failedStartLine(
				undefined,
				{ op: "open", cwd: "/w" },
				1_000,
				[],
				1_500,
				{},
			),
		).toBe(
			'A conversation not yet named, opening in "/w": its open took 0.5 s, failing, with no reason given',
		);
	});
});

describe("firstLine", () => {
	// F23: a reason may quote the path, so its line is escaped as the path is.
	it("escapes the controls left in the line it keeps", () => {
		expect(firstLine(new Error("ENOENT: '/s/\u001b[2J\tx'\nat open"))).toBe(
			"ENOENT: '/s/\\u001b[2J\\tx'",
		);
	});

	// F24: systemd's failures and the roster's refusal carry a reason already
	// escaped, which the journal's line escapes again.
	it("reads the same when a reason it escaped is escaped again", () => {
		const once = firstLine(new Error("ended with 1: /s/\t\u001b\u2028\\x"));

		expect(firstLine(new Error(`failed: ${once}`))).toBe(`failed: ${once}`);
		expect(firstLine(new Error(JSON.stringify("a\nb")))).toBe('"a\\nb"');
	});
});
