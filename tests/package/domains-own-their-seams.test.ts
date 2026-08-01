/**
 * A seam belongs to a domain, never to an extension.
 *
 * The whole point of registering providers over the bus is that a
 * consumer needs the library and never another extension. A Meteorite
 * provider lives in a different package from the review tools and must
 * still be able to join; a World tree provider must join the working
 * layer without importing the extension that hosts it. Both of those
 * hold only while two things stay true: the bus names are declared by
 * the library, and no extension reaches into a sibling.
 *
 * Neither has ever been checked. They are true today, which is the
 * cheapest moment to hold them, since the first violation is invisible
 * from inside the repo that commits it: everything still resolves here,
 * and the downstream package is the one that breaks.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** Every `.ts` file under a directory, recursively. */
function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
		else if (entry.endsWith(".ts")) found.push(path);
	}
	return found;
}

/** The contract suffixes that mark an extension directory. */
const EXTENSION =
	/-(?:integration|workflow|guardian|provider|widget|interceptor|capture)$/;

describe("bus names are declared by a library, not an extension", () => {
	it("finds no versioned bus name declared inside an extension", () => {
		const declared: string[] = [];
		for (const file of sourcesUnder(join(ROOT, "extensions"))) {
			const source = readFileSync(file, "utf8");
			// A declaration assigns the literal; a use merely mentions it.
			// Only the former decides who owns the name.
			for (const match of source.matchAll(
				/=\s*"([a-z][a-z-]*:[a-z][a-z-]*:v\d+)"/g,
			)) {
				declared.push(`${file.slice(ROOT.length + 1)}: ${match[1]}`);
			}
		}

		expect(declared).toEqual([]);
	});

	it("finds the ones that do exist declared in lib", () => {
		const names = new Set<string>();
		for (const file of sourcesUnder(join(ROOT, "lib"))) {
			for (const match of readFileSync(file, "utf8").matchAll(
				/=\s*"([a-z][a-z-]*:[a-z][a-z-]*:v\d+)"/g,
			)) {
				const name = match[1];
				if (name) names.add(name);
			}
		}

		// Proves the check above is looking for something that exists,
		// rather than passing because the pattern never matches anything.
		expect([...names].sort()).toEqual([
			"review:ready:v1",
			"review:request:v1",
			"subagent:ready:v1",
			"subagent:register-default-extension:v1",
			"subagent:register-default-skill:v1",
			"work:ready:v1",
			"work:request:v1",
			"work:tree-claims:v1",
		]);
	});

	it("names a domain, then a topic, then a version", () => {
		const domains = new Set(["review", "subagent", "work"]);
		for (const file of sourcesUnder(join(ROOT, "lib"))) {
			for (const match of readFileSync(file, "utf8").matchAll(
				/=\s*"([a-z][a-z-]*):[a-z][a-z-]*:v\d+"/g,
			)) {
				expect(domains).toContain(match[1]);
			}
		}
	});
});

describe("an extension never imports a sibling extension", () => {
	it("finds no cross-extension import", () => {
		const reaching: string[] = [];
		const extensions = join(ROOT, "extensions");
		for (const file of sourcesUnder(extensions)) {
			const owner = file.slice(extensions.length + 1).split("/")[0];
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/from\s+"(\.\.[^"]*)"/g)) {
				const target = match[1] ?? "";
				// Only a hop that lands in another extension counts. Reaching
				// up into lib is the sanctioned direction and is most of what
				// these files do.
				const segments = target.split("/");
				const landed = segments.find((s) => EXTENSION.test(s));
				if (landed !== undefined && landed !== owner) {
					reaching.push(`${file.slice(ROOT.length + 1)} -> ${target}`);
				}
			}
		}

		expect(reaching).toEqual([]);
	});

	it("would notice one", () => {
		const target = "../review-integration/engine.js";
		const landed = target.split("/").find((s) => EXTENSION.test(s));

		expect(landed).toBe("review-integration");
	});
});
