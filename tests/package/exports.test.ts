/**
 * The exports map is the package's public surface. A library can
 * be public by intent, have a barrel, be documented as public,
 * and still be unreachable from another package, because nothing
 * connects those facts to the map. That is not hypothetical: the
 * review substrate shipped that way, and so did two modules
 * AGENTS.md had called public for longer.
 *
 * AGENTS.md is the source of truth here. It marks a library
 * "(public)" in its Structure section, and that sentence is the
 * commitment; this test is the only thing that makes it one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function exportsMap(): Record<string, string> {
	const raw = readFileSync(join(root, "package.json"), "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("exports" in parsed) ||
		typeof parsed.exports !== "object" ||
		parsed.exports === null
	) {
		throw new Error("package.json has no exports map");
	}
	const map: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed.exports)) {
		if (typeof value === "string") map[key] = value;
	}
	return map;
}

/**
 * The libraries AGENTS.md marks public, read off the bullet that
 * names each one.
 */
function documentedPublic(): string[] {
	const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
	const names: string[] = [];
	let current: string | null = null;
	for (const line of agents.split("\n")) {
		const heading = /^\s*- `lib\/([a-z-]+)\/`:/.exec(line);
		if (heading) {
			current = heading[1];
			if (current === "internal") current = null;
		}
		// The marker can trail the name by several wrapped lines,
		// so it belongs to whichever bullet is still open.
		if (current !== null && line.includes("(public)")) {
			names.push(current);
			current = null;
		}
	}
	return names;
}

describe("the package's exports map", () => {
	it("points every entry at a file that exists", () => {
		const missing = Object.entries(exportsMap())
			.filter(([, path]) => !existsSync(join(root, path)))
			.map(([key, path]) => `${key} -> ${path}`);
		expect(missing).toEqual([]);
	});

	it("exports every library AGENTS.md calls public", () => {
		const exported = new Set(
			Object.values(exportsMap())
				.map((path) => /^\.\/lib\/([^/]+)\//.exec(path)?.[1])
				.filter((name): name is string => name !== undefined),
		);
		const unreachable = documentedPublic().filter(
			(name) => !exported.has(name),
		);
		expect(unreachable).toEqual([]);
	});

	it("finds the public libraries in AGENTS.md at all", () => {
		// Guards the parser above: if the Structure section is
		// reshaped so the markers stop matching, the test before
		// this one passes by reading an empty list.
		expect(documentedPublic()).toContain("review");
		expect(documentedPublic().length).toBeGreaterThan(5);
	});
});
