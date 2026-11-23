/**
 * The loader that lets a test import the shell script it runs, so
 * `--changed` follows an edit to that script alone to the test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptsAsText, unfollowedNames } from "./scripts-as-text.ts";
// Imported only to be named, so `--changed` runs this file when a script
// it reads changes alone; it reads them from their paths below.
import "../../scripts/host-gate.sh";
import "../../scripts/host-run.sh";
import "../../scripts/host-send-runtime.sh";
import "../../scripts/host-test-there.sh";
import "../../scripts/host-test-words.sh";
import "../../scripts/merge-gate.sh";

const folders: string[] = [];

afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/**
 * A shell script on disk with the text given, named `name` in a folder
 * under a fresh one, beside a file for each of `beside`, a path from
 * that folder.
 */
function script(
	text: string,
	beside: readonly string[] = [],
	name = "it.sh",
): string {
	const root = mkdtempSync(join(tmpdir(), "scripts-as-text-"));
	folders.push(root);
	const folder = join(root, "in");
	mkdirSync(folder);
	for (const other of beside) writeFileSync(join(folder, other), "");
	const path = join(folder, name);
	writeFileSync(path, text);
	return path;
}

/** What the loader's module says by default, run as the module it is. */
async function moduleDefault(code: string): Promise<unknown> {
	// A data: URL resolves no relative import, so the scripts it follows
	// are left out: only its text is asked of it.
	const text = code.replace(/^import "[^"]*";\n/gm, "");
	const url = `data:text/javascript,${encodeURIComponent(text)}`;
	const loaded: unknown = await import(url);
	return typeof loaded === "object" && loaded !== null && "default" in loaded
		? loaded.default
		: undefined;
}

describe("scriptsAsText", () => {
	it("loads a shell script as a module whose default is its text", async () => {
		// Quotes, a backtick, a dollar and a backslash: what a script holds
		// and a module's string must keep as they are.
		const text = [
			"#!/usr/bin/env bash",
			`echo "it's \`here\`" $HOME \\n`,
			"",
		].join("\n");
		const code = scriptsAsText().load(script(text));

		expect(code, "a module for a .sh").toBeTypeOf("string");
		expect(await moduleDefault(code ?? "")).toBe(text);
	});

	it("leaves every other file to vite", () => {
		const loader = scriptsAsText();

		expect(loader.load(join(import.meta.dirname, "temp-root.ts"))).toBeNull();
		expect(
			loader.load("/x/it.sh?v=it.sh"),
			"a query is vite's own, though what it ends in reads as a script",
		).toBeNull();
		expect(
			loader.load("\0virtual:thing"),
			"a plugin's own module, which names no file",
		).toBeNull();
		expect(
			loader.load(script("#!/usr/bin/env node\nexport {};\n", [], "tool")),
			"a program with no ending that isn't a shell's",
		).toBeNull();
	});

	// host-gate.sh and host-test-there.sh each source host-test-words.sh,
	// which no test runs by its own path, and run another script beside
	// them, as the ssh guard's wrappers run guard.bash.
	it("imports each script a script sources or runs from beside it, so --changed follows it too", () => {
		const code = scriptsAsText().load(
			script(
				[
					"# shellcheck source=words.sh",
					`source "$(dirname "\${BASH_SOURCE[0]}")/words.sh"`,
					'  . "$(dirname "$0")/more-words.sh"',
					'runner="$(cd "$(dirname "$0")" && pwd)/runner.sh"',
					'exec bash "$here/../guard.bash" "$here"',
					'source "$(dirname "$0")/missing.sh"',
					'source "$HOME/elsewhere.sh"',
					'source "$(git rev-parse --show-toplevel)/root.sh"',
					'"$bash/bin/bash" in/from-root.sh "$@"',
					'echo "usage: in/it.sh"',
					"# called by in/commented.sh, said only in a comment",
					"",
				].join("\n"),
				[
					"words.sh",
					"more-words.sh",
					"runner.sh",
					"../guard.bash",
					"root.sh",
					"from-root.sh",
					"commented.sh",
				],
			),
		);

		expect(
			[...(code ?? "").matchAll(/^import "([^"]+)";$/gm)].map(
				(found) => found[1],
			),
			"the scripts beside it it names, from its folder or the root, and none that isn't there, nor itself",
		).toEqual([
			"./words.sh",
			"./more-words.sh",
			"./runner.sh",
			"../guard.bash",
			"./from-root.sh",
		]);
	});

	it("loads a script with no ending by its shebang, and leaves any other such file", async () => {
		const text = '#!/usr/bin/env bash\nexec bash "$here/../guard.bash"\n';
		const code = scriptsAsText().load(script(text, ["../guard.bash"], "ssh"));
		expect(code, "a module for a wrapper").toContain('import "../guard.bash";');
		expect(await moduleDefault(code ?? "")).toBe(text);
		expect(
			scriptsAsText().load(script("no shebang\n", [], "notes")),
			"a file with no ending and no shebang",
		).toBeNull();
	});

	// A script sourcing or running another named some other way would
	// leave that one out of every test's reach with no word.
	it("names each script beside it, and each source, that it can't follow", () => {
		const path = script("", ["words.sh", "runner.sh"]);
		expect(
			unfollowedNames(
				path,
				[
					`source "$(dirname "\${BASH_SOURCE[0]}")/words.sh"`,
					'source "$HOME/elsewhere.sh"',
					". ./words.sh",
					`"\${here}/runner.sh" go`,
					'source "$(dirname "$0")/words.sh"; source "$HOME/b.sh"',
					'source "$(dirname "$0")/gone.sh"',
					"# runs $dir/runner.sh, said in a comment",
					"echo source",
				].join("\n"),
			),
		).toEqual([
			'source "$HOME/elsewhere.sh": a source named in a way the loader can\'t follow',
			". ./words.sh: names words.sh, beside it, in a way the loader can't follow",
			`"\${here}/runner.sh" go: names runner.sh, beside it, in a way the loader can't follow`,
			'source "$(dirname "$0")/words.sh"; source "$HOME/b.sh": a source named in a way the loader can\'t follow',
			'source "$(dirname "$0")/gone.sh": sources gone.sh, which isn\'t there',
		]);
	});

	it("follows what the host gate's scripts source and run", () => {
		const scripts = join(import.meta.dirname, "..", "..", "scripts");
		for (const name of ["host-gate.sh", "host-test-there.sh"]) {
			expect(
				scriptsAsText().load(join(scripts, name)),
				`${name}'s module`,
			).toContain('import "./host-test-words.sh";');
		}
		for (const [name, runs] of [
			["host-gate.sh", "host-test-there.sh"],
			["host-test-there.sh", "host-send-runtime.sh"],
			["host-test-words.sh", "host-run.sh"],
			["merge-gate.sh", "host-gate.sh"],
		] as const) {
			expect(
				scriptsAsText().load(join(scripts, name)),
				`${name}, running ${runs}`,
			).toContain(`import "./${runs}";`);
		}
	});
});
