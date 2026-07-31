/**
 * A skill's frontmatter stays inside the limits pi enforces.
 *
 * Pi caps a description at 1024 characters and a name at 64. Going over is a warning
 * rather than a refusal, which is exactly why it goes unnoticed: the skill still loads,
 * nothing visibly breaks, and the warning scrolls past at startup among everything else.
 *
 * These descriptions run long for a good reason. Every trigger phrase in one is a phrasing
 * that makes the agent load the skill, and this package learned the hard way what an
 * unloaded skill costs. So the pressure is upward and the ceiling is real, which is the
 * shape of thing that needs a gate rather than good intentions.
 *
 * The margin is deliberate. A description sitting at 1020 is one clarifying phrase away
 * from breaking the build for whoever adds it, so a warning fires with a hundred to spare.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SKILL_ROOTS = [join(ROOT, "skills"), join(ROOT, ".pi", "skills")];

/** Pi's own limits, from its skills documentation. */
const DESCRIPTION_LIMIT = 1024;
const NAME_LIMIT = 64;

/** How close to the ceiling counts as worth knowing about before it lands. */
const HEADROOM = 100;

interface Frontmatter {
	readonly file: string;
	readonly name: string;
	readonly description: string;
}

function skillFiles(): string[] {
	const found: string[] = [];
	for (const root of SKILL_ROOTS) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			// `.pi/skills` is optional, and a package with no project-local
			// skills is not a failure.
			continue;
		}
		for (const entry of entries) {
			const path = join(root, entry);
			if (!statSync(path).isDirectory()) continue;
			const skill = join(path, "SKILL.md");
			try {
				statSync(skill);
				found.push(skill);
			} catch {
				// A directory without a SKILL.md is not a skill.
			}
		}
	}
	return found;
}

/**
 * Read the two capped fields.
 *
 * The description is a folded block scalar in every skill here, so continuation lines join
 * with a space, which is what pi's YAML parser produces and therefore what it measures.
 */
function frontmatterOf(file: string): Frontmatter | undefined {
	const source = readFileSync(file, "utf8");
	const block = source.match(/^---\n([\s\S]*?)\n---\n/);
	if (!block?.[1]) return undefined;
	const name = block[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
	// Deliberately not multiline. With `m` the trailing `$` matches the end of a
	// line rather than the end of the block, so this captured the first line of
	// a folded scalar and nothing else. Every description measured about sixty
	// characters and all three limits passed against a value that was not the
	// description, which is a gate that cannot fail and therefore is not one.
	const folded = block[1].match(
		/description:\s*>-?\s*\n([\s\S]*?)(?=\n[a-z-]+:\s|$)/,
	);
	const plain = block[1].match(/^description:[ \t]*(\S.*)$/m);
	const description = folded?.[1]
		? folded[1]
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "")
				.join(" ")
		: (plain?.[1]?.trim() ?? "");
	return { file: file.slice(ROOT.length + 1), name, description };
}

describe("skill frontmatter", () => {
	const skills = skillFiles()
		.map(frontmatterOf)
		.filter((one): one is Frontmatter => one !== undefined);

	it("finds the skills, so the rest is not passing on an empty list", () => {
		expect(skills.length).toBeGreaterThan(20);
		expect(skills.every((one) => one.description !== "")).toBe(true);
	});

	it("keeps every description inside pi's limit", () => {
		const over = skills
			.filter((one) => one.description.length > DESCRIPTION_LIMIT)
			.map((one) => `${one.file}: ${one.description.length}`);

		expect(over).toEqual([]);
	});

	it("keeps a description off the ceiling, so the next edit is not the one that breaks", () => {
		const tight = skills
			.filter((one) => one.description.length > DESCRIPTION_LIMIT - HEADROOM)
			.map((one) => `${one.file}: ${one.description.length}`);

		expect(tight).toEqual([]);
	});

	it("keeps every name inside pi's limit", () => {
		const over = skills
			.filter((one) => one.name.length > NAME_LIMIT)
			.map((one) => `${one.file}: ${one.name.length}`);

		expect(over).toEqual([]);
	});
});
