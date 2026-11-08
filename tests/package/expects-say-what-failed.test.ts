/**
 * A failing assertion says what was wrong.
 *
 * An expect that hands its matcher only true or false, by `toBe` with a
 * boolean, `toBeTruthy` or `toBeFalsy`, fails saying only that false was
 * not true. The value that made it false was thrown away before the
 * matcher saw it, so the reader has to rerun the test, often with a log
 * line added, to learn anything. So an expect either hands its matcher
 * the value itself, as `toBe(b)`, `toContain(x)`, `toMatch(/^p/)` or
 * `toMatchObject({ ok: true })` do, or carries a message, as its second
 * argument, saying in plain words what should have held. This is rule 8
 * of the repo-quality-standard skill.
 *
 * Only an expect written on one line is read. One a formatter has broken
 * over several lines is missed, which lets some through but never fails a
 * file that keeps the rule. An expect whose argument list holds a comma
 * outside any bracket or string carries a message, and passes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** Folders that are not the package's own: tools' output and checkouts. */
const SKIPPED = new Set(["node_modules", "dist", "coverage"]);

/** A line holding an expect whose matcher is told only true or false. */
const BARE =
	/expect\([^;]*\)\.(toBe\((true|false)\)|toBeTruthy\(\)|toBeFalsy\(\))/;

/** What follows an expect's closing bracket when it is told only true or false. */
const BOOLEAN_MATCHER =
	/^\.(toBe\((true|false)\)|toBeTruthy\(\)|toBeFalsy\(\))/;

/** A bare boolean expect: the file, its line and what the line says. */
interface Bare {
	readonly file: string;
	readonly line: number;
	readonly text: string;
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

/** Where the string opening at `at` closes, past any escaped quote in it. */
function closingQuote(text: string, at: number): number {
	const quote = text.charAt(at);
	for (let next = at + 1; next < text.length; next++) {
		if (text.charAt(next) === "\\") next++;
		else if (text.charAt(next) === quote) return next;
	}
	return text.length;
}

/**
 * The argument list opening at `open`: where it closes, and whether it
 * holds a comma outside any bracket or string, so a second argument. A
 * list that does not close on the line is none.
 */
function argumentsAt(
	text: string,
	open: number,
): { readonly close: number; readonly message: boolean } | undefined {
	let depth = 0;
	let message = false;
	for (let at = open; at < text.length; at++) {
		const char = text.charAt(at);
		if (char === '"' || char === "'" || char === "`") {
			at = closingQuote(text, at);
		} else if ("([{".includes(char)) {
			depth++;
		} else if (")]}".includes(char)) {
			depth--;
			if (depth === 0) return { close: at, message };
		} else if (char === "," && depth === 1) {
			message = true;
		}
	}
	return undefined;
}

/** Whether a line holds an expect told only true or false and given no message. */
function isBare(text: string): boolean {
	if (!BARE.test(text)) return false;
	for (const found of text.matchAll(/\bexpect\(/g)) {
		const list = argumentsAt(text, found.index + "expect".length);
		if (
			list !== undefined &&
			!list.message &&
			BOOLEAN_MATCHER.test(text.slice(list.close + 1))
		)
			return true;
	}
	return false;
}

/** Every bare boolean expect in the package's tests, wherever it is. */
function bareExpects(): Bare[] {
	return sourcesUnder(join(ROOT, "tests")).flatMap((file) =>
		readFileSync(join(ROOT, file), "utf8")
			.split("\n")
			.flatMap((text, index): Bare[] =>
				isBare(text) ? [{ file, line: index + 1, text: text.trim() }] : [],
			),
	);
}

describe("the package's expects", () => {
	it("tell a bare boolean expect from one that says what failed", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it finds what it is meant to and lets the rest by. The
		// matcher is joined on, so this file's own lines are none of them.
		const told = ".toBe(true);";
		expect(isBare(`expect(isAlive(pid))${told}`), "a bare one is found").toBe(
			true,
		);
		expect(
			isBare(`expect(isAlive(pid), \`process \${pid} is gone\`)${told}`),
			"one carrying a message passes",
		).toBe(false);
		expect(
			isBare(`expect(hears(["#a", "#b"], "#a"))${told}`),
			"a comma inside a bracket is no message",
		).toBe(true);
		expect(
			isBare(`expect(said.includes("a, b"))${told}`),
			"a comma inside a string is no message",
		).toBe(true);
	});

	it("each say what failed, not only that it did", () => {
		const bare = bareExpects().map(
			({ file, line, text }) => `${file}:${line}: ${text}`,
		);
		expect(
			bare,
			`these expects tell their matcher only true or false, so they fail saying only that false was not true: hand the matcher the value instead (toBe(b), toContain(x), toMatch(/^p/), toMatchObject({ ok: true })), or give the expect a message saying what should hold:\n${bare.join("\n")}`,
		).toEqual([]);
	});
});
