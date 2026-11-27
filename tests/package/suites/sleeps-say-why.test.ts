/**
 * A test that sleeps says why.
 *
 * A test that waits a fixed time for something to happen is slow where
 * the thing is quick and flaky where the machine is busy: it should wait
 * on the event itself, a file appearing, a message arriving, a timer it
 * drives. Where a real pause is the point, a debounce or a grace being
 * measured, a comment on the line or just above it says so. This is rule
 * 7 of the repo-quality-standard skill, and step 5 of Y9XISP's harness
 * survey (8 November), which counted 147 such sleeps.
 *
 * The sleeps found before this check, each without a comment, are listed
 * per file in `uncommented-sleeps.txt`. The list only shrinks: a file may
 * not gain an uncommented sleep, and a file that loses one has its count
 * lowered.
 *
 * A sleep is a promise resolved by `setTimeout` after a number or a named
 * constant, an awaited `sleep`, `delay`, `pause`, `wait` or `setTimeout`
 * given one, or `Atomics.wait`. A delay named in lower case is a helper's
 * own parameter, whose callers are the sleeps. A file that fakes
 * setTimeout sleeps on none of them, so it is skipped; one that fakes only
 * other timers still sleeps on real ones, so it is read.
 *
 * A test that stops something on a timer, `setTimeout(() => stop.abort(),
 * 200)`, is a sleep by another name, and one any comment can't excuse.
 * Most such stops are right: they end a wait that would otherwise last
 * for good, and land the same whenever they fire. The rest lean on the
 * timer to mean that what's under test got somewhere first, a child
 * started or a request handed over. On a loaded machine it hasn't, so
 * the stop lands early, and the test fails for nothing or passes down a
 * path it never meant to prove. The comment that excused one, "long
 * enough for bash to start the gate's child", named that very race. So a
 * timed stop says why its moment can't matter, in a comment holding
 * `any time:` on its line or in the comment just above. Where the moment
 * matters, the test waits on the thing itself with `until` and stops it
 * then. Every test is read, faked timers or not, since a file faking
 * them in one case may race a real one in the next.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Folders that are not the package's own: tools' output and checkouts. */
const SKIPPED = new Set(["node_modules", "dist", "coverage"]);

/** The shrink-only list of files and how many uncommented sleeps each still has. */
const LIST = join(import.meta.dirname, "uncommented-sleeps.txt");

/** A delay that opens with a number other than 0, or a constant named in capitals. */
const DELAY = String.raw`(?!0\s*\))(?:\d[\d_]*|[A-Z][A-Z0-9_]*)\b`;

/** The ways a test sleeps a fixed time. */
const SLEEPS = [
	new RegExp(String.raw`\bsetTimeout\(\s*\w+\s*,\s*${DELAY}`),
	new RegExp(
		String.raw`\bawait\s+(?:sleep|delay|pause|wait|setTimeout)\(\s*${DELAY}`,
	),
	/\bAtomics\.wait\(/,
];

/** A callback that only stops something, given a fixed delay. */
const TIMED_STOP = new RegExp(
	String.raw`\bsetTimeout\(\s*\(\)\s*=>\s*(?:\{\s*)?[\w.?]+\.abort\([^)]*\)\s*;?\s*\}?\s*,\s*${DELAY}`,
);

/** What a timed stop's comment holds when it says its moment can't matter. */
const ANY_TIME = "any time:";

/** Whether a line sleeps a fixed time. */
function sleeps(line: string): boolean {
	return SLEEPS.some((pattern) => pattern.test(line));
}

/** Whether a line is a comment, or ends with one. */
function says(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		/\S\s*\/\/ /.test(line)
	);
}

/** What a call opening at `from`, just past its `(`, is given, up to its own `)`. */
function givenFrom(text: string, from: number): string {
	let depth = 1;
	for (let at = from; at < text.length; at++) {
		if (text[at] === "(") depth++;
		else if (text[at] === ")" && --depth === 0) return text.slice(from, at);
	}
	return text.slice(from);
}

/**
 * Whether some source fakes setTimeout: fake timers given no list, or a
 * list naming it or held in a name of its own, which is taken to.
 */
function fakesSleeps(text: string): boolean {
	return [...text.matchAll(/useFakeTimers\(/g)].some((call) => {
		const given = givenFrom(text, call.index + call[0].length);
		const list = /toFake\s*:\s*(\[[^\]]*\]|\w+)/.exec(given)?.[1];
		if (list === undefined) return !given.includes("toFake");
		return !list.startsWith("[") || list.includes("setTimeout");
	});
}

/** How many sleeps in some source carry no comment on their line or the line above. */
function uncommentedSleeps(text: string): number {
	if (fakesSleeps(text)) return 0;
	const lines = text.split("\n");
	let count = 0;
	lines.forEach((line, at) => {
		if (!sleeps(line) || says(line)) return;
		let above = at - 1;
		while (above >= 0 && (lines[above] ?? "").trim() === "") above--;
		if (above >= 0 && says(lines[above] ?? "")) return;
		count++;
	});
	return count;
}

/**
 * The lines, counted from 1, that stop something on a timer without
 * saying, on the line or in the comment just above, why any time will do.
 */
function unexcusedTimedStops(text: string): number[] {
	const lines = text.split("\n");
	const found: number[] = [];
	lines.forEach((line, at) => {
		if (!TIMED_STOP.test(line) || line.includes(ANY_TIME)) return;
		let above = at - 1;
		while (above >= 0 && says(lines[above] ?? "")) {
			if ((lines[above] ?? "").includes(ANY_TIME)) return;
			above--;
		}
		found.push(at + 1);
	});
	return found;
}

function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || SKIPPED.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
		else if (entry.endsWith(".ts")) found.push(relative(ROOT, path));
	}
	return found;
}

/** Each test file's uncommented sleeps, for the files that have any. */
function counted(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const file of sourcesUnder(join(ROOT, "tests"))) {
		// This file's own examples are sleeps on purpose.
		if (file === relative(ROOT, import.meta.filename)) continue;
		const count = uncommentedSleeps(readFileSync(join(ROOT, file), "utf8"));
		if (count > 0) counts.set(file, count);
	}
	return counts;
}

/** The list as it stands: each file and the count it may still have. */
function listed(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of readFileSync(LIST, "utf8").split("\n")) {
		const [file, count] = line.trim().split(/\s+/);
		if (file && count && !file.startsWith("#")) counts.set(file, Number(count));
	}
	return counts;
}

describe("the package's tests", () => {
	it("tell a fixed sleep from a wait on something", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it finds what it is meant to and lets the rest by.
		const pause = "await new Promise((r) => setTimeout(r, 50));";
		expect(uncommentedSleeps(pause), "a bare sleep is found").toBe(1);
		expect(
			uncommentedSleeps(`// The debounce is what's measured.\n${pause}`),
			"a sleep with a comment above it passes",
		).toBe(0);
		expect(
			uncommentedSleeps(`${pause} // past the 40 ms grace`),
			"a sleep with a comment on its line passes",
		).toBe(0);
		expect(
			uncommentedSleeps(
				"await sleep(SETTLE_MS);\nawait delay(20, signal);\nawait pause(IDLE_MS * 10);",
			),
			"an awaited helper given a constant, a number or a sum of them is found",
		).toBe(3);
		expect(
			uncommentedSleeps(
				"const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));",
			),
			"a helper's own parameter is no sleep",
		).toBe(0);
		expect(
			uncommentedSleeps("await new Promise((r) => setTimeout(r, 0));"),
			"a turn of the event loop is no sleep",
		).toBe(0);
		expect(
			uncommentedSleeps(`vi.useFakeTimers();\n${pause}`),
			"a file on fake timers sleeps on none",
		).toBe(0);
		expect(
			uncommentedSleeps(
				`vi.useFakeTimers({ toFake: ["setInterval"] });\n${pause}`,
			),
			"a file faking only other timers still sleeps on real ones",
		).toBe(1);
		expect(
			uncommentedSleeps(
				`vi.useFakeTimers({ now: Date.parse("2026-01-01"), toFake: ["Date"] });\n${pause}`,
			),
			"a list after a call of its own is still read",
		).toBe(1);
		expect(
			uncommentedSleeps(
				`vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });\n${pause}`,
			),
			"a file faking setTimeout by name sleeps on none",
		).toBe(0);
		expect(
			uncommentedSleeps(`vi.useFakeTimers({ toFake: FAKED });\n${pause}`),
			"a list held in a name is taken to fake setTimeout",
		).toBe(0);
	});

	it("sleep a fixed time only where a comment says why", () => {
		const now = counted();
		const before = listed();
		const grown = [...now]
			.filter(([file, count]) => count > (before.get(file) ?? 0))
			.map(
				([file, count]) => `${file}: ${count}, listed ${before.get(file) ?? 0}`,
			);
		expect(
			grown,
			`these files sleep a fixed time with no comment saying why: wait on the event instead (a file, a message, a timer the test drives), or say on the line or above it why a real pause is the point:\n${grown.join("\n")}`,
		).toEqual([]);
	});

	it("tell a timed stop that says any time will do from one that doesn't", () => {
		const stop = "setTimeout(() => stop.abort(), 200);";
		expect(unexcusedTimedStops(stop), "a bare timed stop is found").toEqual([
			1,
		]);
		expect(
			unexcusedTimedStops(
				`${stop.slice(0, -1)} // long enough for bash to start the child`,
			),
			"a comment that leans on the timer is no excuse",
		).toEqual([1]);
		expect(
			unexcusedTimedStops(`${stop} // any time: it ends a wait that never ends`),
			"a reason on the line passes",
		).toEqual([]);
		expect(
			unexcusedTimedStops(
				`// any time: the gh never answers,\n// so the stop lands the same.\n${stop}`,
			),
			"a reason anywhere in the comment just above passes",
		).toEqual([]);
		expect(
			unexcusedTimedStops(`// any time: an older reason.\nconst x = 1;\n${stop}`),
			"a reason above some code is another line's",
		).toEqual([3]);
		expect(
			unexcusedTimedStops(
				"const waited = setTimeout(() => { giving.abort(); }, 10 * SPACING);\nsetTimeout(() => c?.abort(\"stopped\"), STOP_MS);",
			),
			"a braced body, a reason and a named or summed delay are found",
		).toEqual([1, 2]);
		expect(
			unexcusedTimedStops("setTimeout(() => stop.abort(), 0);"),
			"a turn of the event loop is no timed stop",
		).toEqual([]);
		expect(
			unexcusedTimedStops(`vi.useFakeTimers();\n${stop}`),
			"a file on fake timers is read too",
		).toEqual([2]);
	});

	it("stop something on a timer only where any time will do", () => {
		const unexcused: string[] = [];
		for (const file of sourcesUnder(join(ROOT, "tests"))) {
			// This file's own examples are timed stops on purpose.
			if (file === relative(ROOT, import.meta.filename)) continue;
			const text = readFileSync(join(ROOT, file), "utf8");
			for (const line of unexcusedTimedStops(text))
				unexcused.push(`${file}:${line}`);
		}
		expect(
			unexcused,
			`these tests stop something on a timer without saying why its moment can't matter: where the stop must land after something happened (a child started, a request handed over), wait for that with until() from tests/support/until.ts and stop it then; otherwise say why any time will do, in a comment holding "${ANY_TIME}" on the line or just above:\n${unexcused.join("\n")}`,
		).toEqual([]);
	});

	it("keep the list of uncommented sleeps no longer than what's left", () => {
		const now = counted();
		const stale = [...listed()]
			.filter(([file, count]) => count > (now.get(file) ?? 0))
			.map(
				([file, count]) => `${file} ${now.get(file) ?? 0} (listed ${count})`,
			);
		expect(
			stale,
			`these files have fewer uncommented sleeps than tests/package/suites/uncommented-sleeps.txt allows; lower each to the count given, or remove it at 0, since the list only shrinks:\n${stale.join("\n")}`,
		).toEqual([]);
	});
});
