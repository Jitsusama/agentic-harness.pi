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
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

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

/** The folder every extension sits straight under. */
const EXTENSIONS = join(ROOT, "extensions");

/**
 * The extension an import from a file lands in, or undefined when it
 * lands outside `extensions/`. Where the import resolves decides, not
 * the names along its path, since `advisor` and `convention-context`
 * carry no contract suffix to be known by.
 */
function extensionReached(file: string, target: string): string | undefined {
	const landed = relative(EXTENSIONS, resolve(dirname(file), target));
	const first = landed.split(sep)[0];
	return first === undefined || first === "" || first === ".."
		? undefined
		: first;
}

describe("bus names are declared by a library, not an extension", () => {
	it("finds no versioned bus name declared inside an extension", () => {
		const declared: string[] = [];
		for (const file of sourcesUnder(join(ROOT, "extensions"))) {
			const source = readFileSync(file, "utf8");
			// A declaration assigns the literal; a use merely mentions it.
			// Only the former decides who owns the name.
			for (const match of source.matchAll(
				/[=]\s*"([a-z][a-z-]*:[a-z][a-z-]*:v\d+)"/g,
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
				/[=]\s*"([a-z][a-z-]*:[a-z][a-z-]*:v\d+)"/g,
			)) {
				const name = match[1];
				if (name) names.add(name);
			}
		}

		// Proves the check above is looking for something that exists,
		// rather than passing because the pattern never matches anything.
		// The review and work names came back with core, folded into
		// `lib/core`.
		expect([...names].sort()).toEqual([
			"budget:ready:v1",
			"budget:register-provider:v1",
			"budget:request:v1",
			"budget:settled:v1",
			"compaction:outcome:v1",
			"compaction:ready:v1",
			"compaction:register-provider:v1",
			"compaction:request:v1",
			"compaction:status:v1",
			"jobs:ask:v1",
			"jobs:carried:v1",
			"jobs:finished:v1",
			"jobs:steer-waiting:v1",
			"jobs:steered:v1",
			"jobs:take-up:v1",
			"jobs:taken-up:v1",
			"jobs:yield:v1",
			"mesh:lease:v1",
			"priority:person-talked:v1",
			"quest:concluded:v1",
			"review:ready:v1",
			"review:request:v1",
			"session:change-closed:v1",
			"session:did:v1",
			"session:landed:v1",
			"session:no-model:v1",
			"session:park-ask:v1",
			"session:parking:v1",
			"session:restart-ask:v1",
			"session:rollover-carry:v1",
			"session:unlanded:v1",
			"session:wakers-ask:v1",
			"session:wants:v1",
			"session:woken:v1",
			"subagent:ready:v1",
			"subagent:register-default-extension:v1",
			"subagent:register-default-skill:v1",
			"work:ready:v1",
			"work:request:v1",
			"work:tree-claims:v1",
			"work:trees-swept:v1",
		]);
	});

	it("names a domain, then a topic, then a version", () => {
		const domains = new Set([
			"budget",
			"compaction",
			"jobs",
			"mesh",
			"priority",
			"quest",
			"review",
			"session",
			"subagent",
			"work",
		]);
		for (const file of sourcesUnder(join(ROOT, "lib"))) {
			for (const match of readFileSync(file, "utf8").matchAll(
				/[=]\s*"([a-z][a-z-]*):[a-z][a-z-]*:v\d+"/g,
			)) {
				expect(domains).toContain(match[1]);
			}
		}
	});
});

describe("an extension never imports a sibling extension", () => {
	it("finds no cross-extension import", () => {
		const reaching: string[] = [];
		for (const file of sourcesUnder(EXTENSIONS)) {
			const owner = file.slice(EXTENSIONS.length + 1).split("/")[0];
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/from\s+"(\.\.[^"]*)"/g)) {
				const target = match[1] ?? "";
				// Only a hop that lands in another extension counts. Reaching
				// up into lib is the sanctioned direction and is most of what
				// these files do.
				const landed = extensionReached(file, target);
				if (landed !== undefined && landed !== owner) {
					reaching.push(`${file.slice(ROOT.length + 1)} -> ${target}`);
				}
			}
		}

		expect(reaching).toEqual([]);
	});

	it("would notice one, whether its name has a suffix or not", () => {
		const file = join(EXTENSIONS, "review-integration", "tools", "ask.ts");

		expect(extensionReached(file, "../../work-integration/engine.ts")).toBe(
			"work-integration",
		);
		expect(extensionReached(file, "../../advisor/index.ts")).toBe("advisor");
		expect(extensionReached(file, "../engine.ts")).toBe("review-integration");
		expect(
			extensionReached(file, "../../../lib/core/review/index.ts"),
		).toBeUndefined();
	});
});
