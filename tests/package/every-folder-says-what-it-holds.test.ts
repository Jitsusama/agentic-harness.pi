/**
 * Every folder in the package says what goes in it.
 *
 * A reader, person or model, finds a file by walking folders by their names,
 * and a folder that says nothing about itself sends them through its files one
 * by one to learn what it is for, and leaves the next person to add something
 * to it guessing whether it belongs. So every folder carries a note: a
 * README.md, an AGENTS.md or a SKILL.md, or an entry file whose first line is
 * a comment (its index.ts, a .ts file inside it of its own name, or one beside
 * it of its name, as `lib/mesh.ts` would be for `lib/mesh/`). A folder may
 * instead be described where its parent's reader already looks: in a bullet
 * of the parent's note that opens with the folder's name and a colon, as
 * lib/README.md describes each library, or, for a folder in a skill,
 * anywhere in its SKILL.md.
 *
 * Tests mirror the source: `tests/extensions/<name>/` holds the tests of
 * `extensions/<name>/`, `tests/lib/<path>/` those of `lib/<path>/`, and
 * `tests/core/<path>/` those of `lib/core/<path>/`, so such a folder says what
 * it holds when its source folder does. A folder of tests with no source
 * folder of its name, such as a support folder, says so itself.
 *
 * A folder still waiting for its note is listed, with why, and the list fails
 * once one has its note or is gone, so it only shrinks. A folder of tests
 * waits with the source folder it mirrors.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** Folders that are not the package's own: tools' output and checkouts. */
const SKIPPED = new Set(["node_modules", "dist", "coverage"]);

/** The notes a folder may carry in a file of their own. */
const NOTES = ["README.md", "AGENTS.md", "SKILL.md"];

/** A first line that is a comment, in TypeScript or a shell script. */
const COMMENT = /^(\/\*\*?|\/\/|#)/;

/** Where each folder of tests finds the source it mirrors. */
const MIRRORS: [string, string][] = [
	["tests/core/", "lib/core/"],
	["tests/lib/", "lib/"],
	["tests/", ""],
];

/**
 * Folders waiting for their note, each with why. Areas being rewritten by
 * their owner keep their shape until the rewrite lands.
 */
const HELD =
	"85PKB2's PLAN-20261025-LES0F4 rewrites this area and owns its shape until it lands";
const FOLDED =
	"folded in from agentic-harness.core (#749, #753, #767, #769, #770); notes come as the fold settles";

const WAITING: Record<string, string> = {
	"extensions/quest-workflow/verbs": HELD,
	"lib/core/internal": FOLDED,
	"lib/core/internal/github": FOLDED,
	"lib/core/internal/guardian": FOLDED,
	"lib/core/internal/lsp": FOLDED,
	"lib/core/internal/notes": FOLDED,
	"lib/core/internal/quest": FOLDED,
	"lib/core/internal/review": FOLDED,
	"lib/core/internal/sqlite": FOLDED,
	"lib/core/internal/terminal": FOLDED,
	"lib/core/internal/terminal/drivers": FOLDED,
	"lib/core/internal/tree": FOLDED,
	"lib/core/internal/tree/providers": FOLDED,
	"lib/core/lsp/standalone": FOLDED,
	"lib/core/notes": FOLDED,
	"lib/core/notes/verbs": FOLDED,
	"lib/core/quest/verbs": FOLDED,
	"lib/core/review/ask": FOLDED,
	"lib/core/review/draft": FOLDED,
	"lib/core/review/providers": FOLDED,
	"lib/core/sections": FOLDED,
	"lib/core/title": FOLDED,
	"lib/core/work/providers": FOLDED,
};

function foldersUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || SKIPPED.has(entry)) continue;
		const path = join(dir, entry);
		if (!statSync(path).isDirectory()) continue;
		found.push(relative(ROOT, path), ...foldersUnder(path));
	}
	return found;
}

function opensWithAComment(file: string): boolean {
	if (!existsSync(file) || !statSync(file).isFile()) return false;
	const first = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
	return COMMENT.test(first);
}

/**
 * Whether a note in the folder's parent describes it in a bullet that opens
 * with its name and a colon: `- \`away/\`:`, `- **\`away/\`**:` or
 * `- **[\`away/\`](away/)**:`.
 */
function described(path: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const bullet = new RegExp(
		`^\\s*- (\\*\\*)?\\[?\`${escaped}/\`(\\]\\([^)]*\\))?(\\*\\*)?:`,
		"m",
	);
	return NOTES.some((note) => {
		const file = join(dirname(path), note);
		return existsSync(file) && bullet.test(readFileSync(file, "utf8"));
	});
}

/** Whether a folder carries a note of its own. */
function notes(folder: string): boolean {
	const path = join(ROOT, folder);
	const name = basename(folder);
	if (NOTES.some((note) => existsSync(join(path, note)))) return true;
	if (described(path, name)) return true;
	const skill = join(dirname(path), "SKILL.md");
	if (existsSync(skill) && readFileSync(skill, "utf8").includes(`${name}/`))
		return true;
	return [
		join(path, "index.ts"),
		join(path, `${name}.ts`),
		join(dirname(path), `${name}.ts`),
	].some(opensWithAComment);
}

/** The source folder a folder of tests mirrors, when there is one. */
function mirrored(folder: string): string | undefined {
	for (const [tests, source] of MIRRORS) {
		if (!folder.startsWith(tests)) continue;
		const path = source + folder.slice(tests.length);
		if (existsSync(join(ROOT, path))) return path;
	}
	return undefined;
}

/** Whether a folder says what it holds, by its own note or its source's. */
function says(folder: string): boolean {
	if (notes(folder)) return true;
	const source = mirrored(folder);
	return source !== undefined && says(source);
}

/** Whether a folder is waiting for its note, or mirrors one that is. */
function waits(folder: string): boolean {
	if (folder in WAITING) return true;
	const source = mirrored(folder);
	return source !== undefined && waits(source);
}

describe("the package's folders", () => {
	const folders = foldersUnder(ROOT);

	it("each say what they hold", () => {
		const silent = folders.filter((f) => !says(f) && !waits(f));
		expect(
			silent,
			`these folders don't say what they hold: give each a README.md, an index.ts or a file of its name whose first line is a comment saying what goes in it, or a bullet in its parent's README opening with its name and a colon:\n${silent.join("\n")}`,
		).toEqual([]);
	});

	it("keep no folder waiting that has its note or is gone", () => {
		const spoken = Object.keys(WAITING).filter(
			(f) => !existsSync(join(ROOT, f)) || says(f),
		);
		expect(
			spoken,
			`waiting for a note they now have, or gone; take them out of WAITING:\n${spoken.join("\n")}`,
		).toEqual([]);
	});
});
