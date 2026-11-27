/**
 * The lint refuses a recursive delete in every form it can be written
 * in, and lets a delete that can't recurse pass.
 *
 * lib/internal/files/recursive-delete.grit is what keeps Node's own walk
 * out of the code, and a clean `pnpm lint` would read the same for a
 * rule that matched nothing. So this lints a sample of each form through
 * the repository's own Biome and its own config, and says which lines
 * the rule refused. The sample sits in `.worktrees/`, which git ignores,
 * since Biome crashes on a file outside the project and runs no plugin
 * on its standard input; its folder is this run's own, and goes after.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTree } from "../../lib/internal/files/remove-tree.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** Each form, by the line it is on, and whether the rule refuses it. */
const FORMS: readonly (readonly [string, boolean])[] = [
	['rmSync("a", { recursive: true });', true],
	['rmSync("b", options);', true],
	['fs.rm("c", { recursive: true }, () => undefined);', true],
	['await promises.rm("d", { force: true, recursive: true });', true],
	['await promises.rm("e", { ...options });', true],
	['fs.rmSync("f", made());', true],
	['rmdirSync("g", { recursive: true });', true],
	['rmSync("l", { recursive: deep });', true],
	['rmSync("m", { force: true, recursive });', true],
	['rmSync("h", { recursive: false });', false],
	['rmSync("i", { force: true });', false],
	['rmSync("j");', false],
	['fs.rm("k", () => undefined);', false],
];

/** What leads the sample, so each form's line is its index past it. */
const LEAD = [
	'import * as fs from "node:fs";',
	'import { promises, rmdirSync, rmSync } from "node:fs";',
	"const options = { recursive: true };",
	"const made = () => options;",
	"const deep = true;",
	"const recursive = true;",
];

const folder = join(ROOT, ".worktrees", `recursive-delete-${process.pid}`);

afterAll(() => removeTree(folder));

/** The lines of `file` the recursive-delete rule refused, by number. */
function refusedLines(file: string): number[] {
	const biome = createRequire(import.meta.url).resolve(
		"@biomejs/biome/bin/biome",
	);
	const ran = spawnSync(
		process.execPath,
		[
			biome,
			"lint",
			"--only=plugin",
			"--vcs-use-ignore-file=false",
			"--max-diagnostics=none",
			relative(ROOT, file),
		],
		{ cwd: ROOT, encoding: "utf8" },
	);
	const said = `${ran.stdout}${ran.stderr}`;
	expect(said, "Biome checked nothing, so nothing was shown").toContain(
		"Checked 1 file",
	);
	// A rule that fails to run says so as a note and lints clean.
	expect(said, "the rule failed to run").not.toContain("errored");
	const name = relative(ROOT, file).replaceAll("\\", "/");
	return [...said.matchAll(/(\S+):(\d+):\d+ plugin/gu)]
		.filter(([, path]) => path === name)
		.map(([, , line]) => Number(line));
}

describe("the recursive-delete lint", () => {
	it("refuses each recursive form and lets the rest pass", () => {
		mkdirSync(folder, { recursive: true });
		const sample = join(folder, "sample.ts");
		writeFileSync(
			sample,
			`${[...LEAD, ...FORMS.map(([form]) => form)].join("\n")}\n`,
		);
		const refused = refusedLines(sample);
		const said = FORMS.map(([form], at) => [
			form,
			refused.includes(LEAD.length + at + 1),
		]);
		expect(said, "the rule refused other lines than those it should").toEqual(
			FORMS,
		);
	});
});
