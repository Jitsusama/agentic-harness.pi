/**
 * The exports map is the package's public surface. A library can
 * be public by intent, have a barrel, be documented as public,
 * and still be unreachable from another package, because nothing
 * connects those facts to the map. That is not hypothetical: the
 * review substrate shipped that way, and so did two modules
 * AGENTS.md had called public for longer.
 *
 * lib/README.md is the source of truth here. Its Public Modules
 * section lists each public library, and that list is the
 * commitment; this test is the only thing that makes it one. It
 * holds both ways, since the list drifted the other way too: it
 * named five modules that had moved to core and missed eleven that
 * were exported.
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
 * The libraries lib/README.md lists as public, read off the bullet
 * that names each one in its Public Modules section.
 */
function documentedPublic(): string[] {
	const readme = readFileSync(join(root, "lib", "README.md"), "utf8");
	const section = readme
		.split(/^## /m)
		.find((part) => part.startsWith("Public Modules"));
	if (section === undefined) return [];
	const names: string[] = [];
	for (const line of section.split("\n")) {
		const bullet = /^- \*\*\[`([a-z-]+)\/`\]/.exec(line);
		if (bullet) names.push(bullet[1]);
	}
	return names;
}

/** The libraries the exports map reaches, by their folder under lib/. */
function exportedLibraries(): Set<string> {
	return new Set(
		Object.values(exportsMap())
			.map((path) => /^\.\/lib\/([^/]+)\//.exec(path)?.[1])
			.filter((name): name is string => name !== undefined),
	);
}

describe("the package's exports map", () => {
	it("points every entry at a file that exists", () => {
		const missing = Object.entries(exportsMap())
			.filter(([, path]) => !existsSync(join(root, path)))
			.map(([key, path]) => `${key} -> ${path}`);
		expect(missing).toEqual([]);
	});

	it("exports every library lib/README.md calls public", () => {
		const exported = exportedLibraries();
		const unreachable = documentedPublic().filter(
			(name) => !exported.has(name),
		);
		expect(unreachable).toEqual([]);
	});

	it("lists every exported library in lib/README.md", () => {
		const documented = new Set(documentedPublic());
		const unlisted = [...exportedLibraries()].filter(
			(name) => !documented.has(name),
		);
		expect(unlisted).toEqual([]);
	});

	it("finds the public libraries in lib/README.md at all", () => {
		// Guards the parser above: if the Structure section is
		// reshaped so the markers stop matching, the test before
		// this one passes by reading an empty list.
		expect(documentedPublic()).toContain("guardian");
		expect(documentedPublic().length).toBeGreaterThan(5);
	});
});
