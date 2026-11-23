/**
 * The loader that lets a test import the shell script it runs, so
 * `--changed` follows an edit to that script alone to the test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptsAsText, unfollowedSources } from "./scripts-as-text.ts";
// Imported only to be named, so `--changed` runs this file when a script
// it reads changes alone; it reads them from their paths below.
import "../../scripts/host-gate.sh";
import "../../scripts/host-test-there.sh";

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
	const url = `data:text/javascript,${encodeURIComponent(code)}`;
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
		expect(loader.load("/x/it.sh?raw"), "a query is vite's own").toBeNull();
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
					"",
				].join("\n"),
				["words.sh", "more-words.sh", "runner.sh", "../guard.bash"],
			),
		);

		expect(
			[...(code ?? "").matchAll(/^import "([^"]+)";$/gm)].map(
				(found) => found[1],
			),
			"the scripts beside it it names, and none that isn't there",
		).toEqual([
			"./words.sh",
			"./more-words.sh",
			"./runner.sh",
			"../guard.bash",
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

	// A script sourcing another named some other way would leave that one
	// out of every test's reach with no word.
	it("names each source line it can't follow", () => {
		const path = script("", ["words.sh"]);
		expect(
			unfollowedSources(
				path,
				[
					`source "$(dirname "\${BASH_SOURCE[0]}")/words.sh"`,
					'source "$HOME/elsewhere.sh"',
					". ./words.sh",
					"echo source",
				].join("\n"),
			),
		).toEqual(['source "$HOME/elsewhere.sh"', ". ./words.sh"]);
	});

	it("follows what the host gate's scripts source and run", () => {
		const scripts = join(import.meta.dirname, "..", "..", "scripts");
		for (const name of ["host-gate.sh", "host-test-there.sh"]) {
			expect(
				scriptsAsText().load(join(scripts, name)),
				`${name}'s module`,
			).toContain('import "./host-test-words.sh";');
		}
		expect(
			scriptsAsText().load(join(scripts, "host-gate.sh")),
			"the runner it starts",
		).toContain('import "./host-test-there.sh";');
	});

	it("asks vite to run it before its own loading, which would read a script as JavaScript", () => {
		expect(scriptsAsText().enforce).toBe("pre");
	});
});
