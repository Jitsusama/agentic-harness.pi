/**
 * A parameter has to name the modes that read it.
 *
 * The schema is what a model reads before it reaches for a skill,
 * so a capability that is absent from a parameter's description is
 * absent, whatever the code does. This is not hypothetical. Four
 * reviewers were asked what these tools could not do, and two of
 * the eight gaps they reported were not gaps: the feature existed
 * and could not be found. One of them was `see kind:"shot"` with
 * `within`, which crops the picture to a single element. The
 * parameter explained itself for reads and for `kind:"element"`,
 * never mentioned shots, and a designer with the whole source in
 * front of them concluded it was missing and described the
 * workaround they would have to build.
 *
 * So this checks the mechanical part of that: where a parameter is
 * read inside the branch for a given kind, its description names
 * that kind. It cannot see a parameter the branch reads after
 * destructuring, and it cannot judge whether prose is clear. Both
 * of those are false negatives, which is the right way for a gate
 * like this to fail. What it does catch is the exact shape of the
 * defect that shipped: a branch quietly growing a use for a
 * parameter whose description was written before that branch
 * existed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOOLS = ["see", "go", "do", "check"] as const;

/** Each schema property's name and its description text. */
function describedParams(source: string): Map<string, string> {
	const found = new Map<string, string>();
	const property = /^\t(\w+):\s*Type\./gm;
	let match: RegExpExecArray | null = property.exec(source);
	for (; match !== null; match = property.exec(source)) {
		const body = source.slice(match.index, closingParen(source, match.index));
		const described = /description:\s*((?:\s*"(?:[^"\\]|\\.)*"\s*\+?)+)/.exec(
			body,
		);
		if (!described) continue;
		found.set(
			match[1],
			described[1]
				.split("+")
				.map((piece) => piece.trim().replace(/^"|"$/g, ""))
				.join(""),
		);
	}
	return found;
}

/** Where the parenthesis opened at or after `from` closes. */
function closingParen(source: string, from: number): number {
	let depth = 0;
	for (let i = source.indexOf("(", from); i < source.length; i++) {
		if (source[i] === "(") depth++;
		else if (source[i] === ")" && --depth === 0) return i;
	}
	return source.length;
}

interface Branch {
	readonly kind: string;
	readonly start: number;
	readonly end: number;
}

/** The extent of each `kind === "x"` branch, by brace matching. */
function branches(source: string): Branch[] {
	const found: Branch[] = [];
	const test = /kind === "(\w+)"/g;
	let match: RegExpExecArray | null = test.exec(source);
	for (; match !== null; match = test.exec(source)) {
		const open = source.indexOf("{", match.index);
		if (open < 0) continue;
		let depth = 0;
		for (let i = open; i < source.length; i++) {
			if (source[i] === "{") depth++;
			else if (source[i] === "}" && --depth === 0) {
				found.push({ kind: match[1], start: open, end: i });
				break;
			}
		}
	}
	return found;
}

/** Every `params.x` read inside a branch, keyed by parameter. */
function readsPerParam(
	source: string,
	within: Branch[],
): Map<string, Set<string>> {
	const reads = new Map<string, Set<string>>();
	const use = /params\.(\w+)/g;
	let match: RegExpExecArray | null = use.exec(source);
	for (; match !== null; match = use.exec(source)) {
		const index = match.index;
		const enclosing = within.filter((b) => index > b.start && index < b.end);
		if (enclosing.length === 0) continue;
		// The innermost branch is the one that owns the read.
		const owner = enclosing.reduce((a, b) => (b.start > a.start ? b : a));
		const already = reads.get(match[1]) ?? new Set<string>();
		already.add(owner.kind);
		reads.set(match[1], already);
	}
	return reads;
}

describe("browser tool parameter descriptions", () => {
	for (const tool of TOOLS) {
		it(`names every kind that reads a parameter in browser_${tool}`, () => {
			const source = readFileSync(
				join("extensions", "browser-integration", `${tool}.ts`),
				"utf-8",
			);
			const described = describedParams(source);
			const reads = readsPerParam(source, branches(source));

			const silent: string[] = [];
			for (const [param, kinds] of reads) {
				// The kind selector itself, and the session it acts on,
				// are read everywhere and belong to no one branch.
				if (param === "kind" || param === "session") continue;
				const description = described.get(param);
				if (description === undefined) continue;
				for (const kind of kinds) {
					if (!description.includes(kind)) {
						silent.push(`${param} is read by '${kind}' but never names it`);
					}
				}
			}

			expect(silent).toEqual([]);
		});
	}

	it("can tell when a description has fallen behind its code", () => {
		// The gate is worth no more than its ability to fail, and its
		// matching is regex over source, so prove it against the shape
		// that actually shipped rather than trusting it because it is
		// quiet.
		const stale = [
			'\tonly: Type.Optional(Type.String({ description: "For reads." })),',
			"execute: () => {",
			'\tif (kind === "shot") { return take(params.only); }',
			"}",
		].join("\n");

		const reads = readsPerParam(stale, branches(stale));

		expect(reads.get("only")).toEqual(new Set(["shot"]));
		expect(describedParams(stale).get("only")).toBe("For reads.");
	});
});
