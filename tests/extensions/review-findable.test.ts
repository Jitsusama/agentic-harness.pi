/**
 * A parameter has to be declared, and has to name the actions that read it.
 *
 * The schema is what a model reads before it reaches for a skill, so a
 * capability absent from a parameter's description is absent whatever
 * the code does. The sibling gate on the browser tools was built after
 * four reviewers reported eight gaps, two of which were features that
 * existed and could not be found.
 *
 * Both halves earned their place here on the first run. The declaration
 * check found `commit`, which `fix-done` requires and the schema never
 * declared, so the one action that needs it could never have received
 * it. The description check found ten parameters whose text named none
 * of the actions reading them.
 *
 * It cannot see a parameter read after destructuring, and it cannot
 * judge whether prose is clear. Both are false negatives, which is the
 * right way for a gate like this to be wrong.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOOLS = ["read", "see", "say", "ask", "draft", "offer"] as const;

function source(tool: string): string {
	return readFileSync(
		join("extensions", "review-integration", "tools", `${tool}.ts`),
		"utf-8",
	);
}

/** Every `params.x` the implementation reads. */
function readParams(text: string): Set<string> {
	return new Set(
		[...text.matchAll(/params\.(\w+)/g)].map((match) => match[1] as string),
	);
}

/** Every property the schema declares, with its description text. */
function declared(text: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const match of text.matchAll(/^\t{3}([a-zA-Z]+): Type\./gm)) {
		const name = match[1];
		if (name === undefined) continue;
		// The description, when there is one, sits inside the next
		// stretch of the declaration rather than at a fixed offset.
		const window = text.slice(match.index, match.index + 1200);
		const described = /description:\s*((?:\s*"(?:[^"\\]|\\.)*"\s*\+?)+)/.exec(
			window,
		);
		found.set(
			name,
			described?.[1]
				?.split("+")
				.map((piece) => piece.trim().replace(/^"|"$/g, ""))
				.join("") ?? "",
		);
	}
	return found;
}

/** The extent of each action branch, in either form the tools use. */
function branches(
	text: string,
): Array<[action: string, from: number, to: number]> {
	const found: Array<[string, number, number]> = [];
	// `params.action === "x"` guarding a block.
	for (const match of text.matchAll(/action === "([a-zA-Z-]+)"/g)) {
		const open = text.indexOf("{", match.index + match[0].length);
		if (open < 0) continue;
		let depth = 0;
		for (let i = open; i < text.length; i++) {
			if (text[i] === "{") depth++;
			else if (text[i] === "}" && --depth === 0) {
				found.push([match[1] as string, open, i]);
				break;
			}
		}
	}
	// `case "x":` inside a switch, running to the next case or to the
	// end of the switch. Bounding the last case at end-of-file instead
	// swallows every helper defined below it, which attributed nine of
	// `offer`'s parameters to whichever action happened to be last.
	for (const open of switchBodies(text)) {
		const cases = [...text.matchAll(/case "([a-zA-Z-]+)":/g)].filter(
			(match) => match.index > open[0] && match.index < open[1],
		);
		for (const [at, match] of cases.entries()) {
			const next = cases[at + 1]?.index ?? open[1];
			found.push([match[1] as string, match.index, next]);
		}
	}
	return found;
}

/** The body of each `switch`, as a brace-matched span. */
function switchBodies(text: string): Array<[from: number, to: number]> {
	const found: Array<[number, number]> = [];
	for (const match of text.matchAll(/switch\s*\(/g)) {
		const open = text.indexOf("{", match.index);
		if (open < 0) continue;
		let depth = 0;
		for (let i = open; i < text.length; i++) {
			if (text[i] === "{") depth++;
			else if (text[i] === "}" && --depth === 0) {
				found.push([open, i]);
				break;
			}
		}
	}
	return found;
}

/** Which actions read each parameter, by the innermost owning branch. */
function readsPerParam(text: string): Map<string, Set<string>> {
	const within = branches(text);
	const reads = new Map<string, Set<string>>();
	for (const match of text.matchAll(/params\.(\w+)/g)) {
		const name = match[1];
		if (name === undefined || name === "action") continue;
		const enclosing = within.filter(
			([, from, to]) => match.index > from && match.index < to,
		);
		if (enclosing.length === 0) continue;
		const owner = enclosing.reduce((a, b) => (b[1] > a[1] ? b : a));
		const already = reads.get(name) ?? new Set<string>();
		already.add(owner[0]);
		reads.set(name, already);
	}
	return reads;
}

describe("review tool parameters", () => {
	for (const tool of TOOLS) {
		it(`declares every parameter the ${tool} tool reads`, () => {
			const text = source(tool);
			const schema = declared(text);
			// A parameter the code reads and the schema omits cannot be
			// sent at all, so the action needing it can never succeed.
			const undeclaredParams = [...readParams(text)].filter(
				(name) => !schema.has(name),
			);

			expect(
				undeclaredParams,
				`These are read but not declared, so no caller can pass them: ${undeclaredParams.join(", ")}`,
			).toEqual([]);
		});

		it(`names every action that reads a parameter in ${tool}`, () => {
			const text = source(tool);
			const schema = declared(text);
			const gaps: string[] = [];
			for (const [name, actions] of readsPerParam(text)) {
				const description = schema.get(name);
				if (description === undefined) continue;
				const unnamed = [...actions].filter(
					(action) => !description.includes(action),
				);
				if (unnamed.length > 0) {
					gaps.push(`${name} is read by ${unnamed.join(", ")}`);
				}
			}

			expect(
				gaps,
				`A model reads the schema before it reads a skill, so these capabilities are invisible: ${gaps.join("; ")}`,
			).toEqual([]);
		});
	}

	it("finds the branches it claims to be checking", () => {
		// Guards against both regexes silently matching nothing, which
		// would make every case above pass by having no work to do.
		const text = source("draft");

		expect(branches(text).length).toBeGreaterThan(8);
		expect(readsPerParam(text).size).toBeGreaterThan(4);
	});
});
