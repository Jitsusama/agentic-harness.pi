/**
 * The loader that lets a test import the shell script it runs, so
 * `--changed` follows an edit to that script alone to the test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isShellScript,
	scriptsAsText,
	unfollowedNames,
} from "./scripts-as-text.ts";
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

/** A shebang a shell program with no ending opens with, with env's options. */
const PROGRAM = "#!/usr/bin/env -S bash -eu\n";

/**
 * A shell script on disk with the text given, named `name` in a folder
 * `in` under a fresh root, beside a file for each of `beside`, a path
 * from that folder, or that path and its text: empty, or a shell's
 * shebang for a name with no ending.
 */
function script(
	text: string,
	beside: readonly (string | readonly [string, string])[] = [],
	name = "it.sh",
): string {
	const root = mkdtempSync(join(tmpdir(), "scripts-as-text-"));
	folders.push(root);
	const folder = join(root, "in");
	mkdirSync(folder);
	for (const other of beside) {
		const [file, body] =
			typeof other === "string"
				? [other, other.includes(".") ? "" : PROGRAM]
				: other;
		mkdirSync(dirname(join(folder, file)), { recursive: true });
		writeFileSync(join(folder, file), body);
	}
	const path = join(folder, name);
	writeFileSync(path, text);
	return path;
}

/** The root `script` made `path` under. */
function rootOf(path: string): string {
	return dirname(dirname(path));
}

/** The scripts the loader's module for `path` imports, read from its root. */
function importsOf(path: string): string[] {
	const code = scriptsAsText(rootOf(path)).load(path) ?? "";
	return [...code.matchAll(/^import "([^"]+)";$/gm)].map(
		(found) => found[1] ?? "",
	);
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
	it("imports each script a script names that is there, so --changed follows it too", () => {
		const path = script(
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
				'cd "$(dirname "$0")" && bash helper.sh',
				'exec "$here/lib/send.sh"',
				`. "\${SCRIPT_DIR}/.common.sh"`,
				"bash scripts/run.sh",
				'exec "$here/wrapper" "$@"',
				"cat notes",
				"",
			].join("\n"),
			[
				"words.sh",
				"more-words.sh",
				"runner.sh",
				"../guard.bash",
				"../root.sh",
				"from-root.sh",
				"commented.sh",
				"helper.sh",
				"lib/send.sh",
				".common.sh",
				"../scripts/run.sh",
				"wrapper",
				["notes", "plain words\n"],
			],
		);

		expect(
			importsOf(path),
			"each it names that is there, from its folder or the root, but itself and a file that is no script",
		).toEqual([
			"./words.sh",
			"./more-words.sh",
			"./runner.sh",
			"../guard.bash",
			"../root.sh",
			"./from-root.sh",
			"./helper.sh",
			"./lib/send.sh",
			"./.common.sh",
			"../scripts/run.sh",
			"./wrapper",
		]);
	});

	// A script run from the root names its own from there; one beside the
	// naming script with the same name is another script.
	it("reads a name from the naming script's folder before the root", () => {
		const path = script("bash scripts/run.sh\n", [
			"scripts/run.sh",
			"../scripts/run.sh",
		]);
		expect(importsOf(path)).toEqual(["./scripts/run.sh"]);
	});

	it("loads a script with no ending by its shebang, and leaves any other such file", async () => {
		const text = '#!/usr/bin/env bash\nexec bash "$here/../guard.bash"\n';
		const path = script(text, ["../guard.bash"], "ssh");
		const code = scriptsAsText(rootOf(path)).load(path);
		expect(code, "a module for a wrapper").toContain('import "../guard.bash";');
		expect(await moduleDefault(code ?? "")).toBe(text);
		expect(
			scriptsAsText().load(script("no shebang\n", [], "notes")),
			"a file with no ending and no shebang",
		).toBeNull();
	});

	it.each([
		"#!/bin/sh",
		"#!/bin/bash",
		"#!/usr/bin/env bash",
		"#!/usr/bin/env -S bash -euo pipefail",
		"#!/nix/store/0abc-bash-5.2/bin/bash",
		"#! /usr/bin/env zsh",
	])("reads a file with no ending and the shebang %s as a shell's", (line) => {
		expect(
			isShellScript(script(`${line}\necho\n`, [], "tool")),
			"read as a shell's",
		).toBe(true);
	});

	it.each([
		"#!/usr/bin/env node",
		"#!/usr/bin/env -S node --test",
		"#!/usr/bin/python3",
		"#!/usr/bin/env shellcheck",
	])("reads a file with no ending and the shebang %s as no shell's", (line) => {
		expect(
			isShellScript(script(`${line}\necho\n`, [], "tool")),
			"read as another program's",
		).toBe(false);
	});

	// A slip of a name only beside the script can mean leaves the script
	// meant out of every test's reach; any other name, a script elsewhere
	// or a file made as it runs, is the script's own business.
	it("names each script beside it that it names in a way meaning only there, and isn't there", () => {
		const path = script("", ["words.sh", "runner.sh"]);
		expect(
			unfollowedNames(
				path,
				[
					`source "$(dirname "\${BASH_SOURCE[0]}")/words.sh"`,
					'source "$HOME/elsewhere.sh"',
					". ./words.sh",
					`"\${here}/runner.sh" go`,
					"source /etc/os-release.sh",
					'cd "$(dirname "$0")" && bash helper.sh',
					'source "$(dirname "$0")/gone.sh"',
					'"$(cd "$(dirname "$0")" && pwd)/lost.sh"',
					`. "\${BASH_SOURCE%/*}/strayed.sh"`,
					'# runs "$(dirname "$0")/said.sh", in a comment',
					'source "$(dirname $0)/bare.sh"',
					'. "$(dirname "$BASH_SOURCE")/plain.sh"',
					'source "$(dirname "$config")/defaults.sh"',
					'"$(cd "$repo" && pwd)/tool.sh"',
					'"$(cd "$(dirname "$config")" && pwd)/its.sh"',
					'source "$(dirname "$0")"/split.sh',
					'. "$(dirname -- "$0")/dashed.sh"',
					'"$(cd "$(dirname "$0")"; pwd)/semi.sh"',
					`"$(CDPATH= cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" &> /dev/null && pwd)/safe.sh"`,
					`. "\${0%/*}/cut.sh"`,
					`. "\${BASH_SOURCE[0]%/*}/indexed.sh"`,
					'source "$(dirname "$(realpath "$0")")/real.sh"',
					'echo $# "$(dirname "$0")/counted.sh"',
					'run_it  # was "$(dirname "$0")/old.sh"',
				].join("\n"),
			),
			"the folder of the script itself, never of another file",
		).toEqual([
			'source "$(dirname "$0")/gone.sh": names gone.sh beside it, which isn\'t there to follow',
			'"$(cd "$(dirname "$0")" && pwd)/lost.sh": names lost.sh beside it, which isn\'t there to follow',
			`. "\${BASH_SOURCE%/*}/strayed.sh": names strayed.sh beside it, which isn't there to follow`,
			'source "$(dirname $0)/bare.sh": names bare.sh beside it, which isn\'t there to follow',
			'. "$(dirname "$BASH_SOURCE")/plain.sh": names plain.sh beside it, which isn\'t there to follow',
			'source "$(dirname "$0")"/split.sh: names split.sh beside it, which isn\'t there to follow',
			'. "$(dirname -- "$0")/dashed.sh": names dashed.sh beside it, which isn\'t there to follow',
			'"$(cd "$(dirname "$0")"; pwd)/semi.sh": names semi.sh beside it, which isn\'t there to follow',
			`"$(CDPATH= cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" &> /dev/null && pwd)/safe.sh": names safe.sh beside it, which isn't there to follow`,
			`. "\${0%/*}/cut.sh": names cut.sh beside it, which isn't there to follow`,
			`. "\${BASH_SOURCE[0]%/*}/indexed.sh": names indexed.sh beside it, which isn't there to follow`,
			'source "$(dirname "$(realpath "$0")")/real.sh": names real.sh beside it, which isn\'t there to follow',
			'echo $# "$(dirname "$0")/counted.sh": names counted.sh beside it, which isn\'t there to follow',
		]);
	});

	// The shell's own reading of a comment, since cutting code as one
	// drops a follow without a word, and reading one as code fails the
	// package rule over a name the shell never reads.
	it("reads a comment where the shell does: a word opening with # outside quotes and expansions, quotes running on across lines", () => {
		const path = script("");
		const names = (lines: readonly string[]) =>
			unfollowedNames(path, lines.join("\n")).map((said) =>
				said.replace(/^.*: names (\S+) beside it.*$/, "$1"),
			);
		expect(
			names([
				'echo "a # b" "$(dirname "$0")/quoted.sh"',
				`echo 'it''s # c' "$(dirname "$0")/reopened.sh"`,
				`x=\${#arr[@]} "$(dirname "$0")/sized.sh"`,
				`rest=\${line%% #*} "$(dirname "$0")/trimmed.sh"`,
				'usage="the first line',
				'  see #2: $(dirname "$0")/spanning.sh"',
				'echo \\" # "$(dirname "$0")/escaped.sh"',
				'run;# was "$(dirname "$0")/after-semicolon.sh"',
				'run|# "$(dirname "$0")/after-pipe.sh"',
				'(run)# "$(dirname "$0")/after-paren.sh"',
				"cat <<EOF",
				"it's a body",
				"EOF",
				'# past the body "$(dirname "$0")/past-body.sh"',
				"bash -s <<-'SAID'",
				'\trun #1 "$(dirname "$0")/fed.sh"',
				'\techo "open',
				"\tSAID",
				'# past the fed body "$(dirname "$0")/past-fed.sh"',
				'echo "$(dirname "$0")/last.sh"',
			]),
			"a heredoc's lines each read alone, as a script fed to a shell is",
		).toEqual([
			"quoted.sh",
			"reopened.sh",
			"sized.sh",
			"trimmed.sh",
			"spanning.sh",
			"last.sh",
		]);
	});

	it("reads each spelling of its own folder, and none of its parent's or a longer name", () => {
		const path = script("");
		expect(
			unfollowedNames(
				path,
				[
					'source "$(dirname "$(readlink -f "$0")")/linked.sh"',
					`. "$(dirname "\${0}")/braced.sh"`,
					`"$(CDPATH='' cd "$(dirname "$0")" > /dev/null 2>&1 && pwd)/quiet.sh"`,
					'"$(CDPATH="" cd "$(dirname "$0")" && pwd)/emptied.sh"',
					'source "$(dirname "$(dirname "$0")")/parent.sh"',
					'"$(cd "$(dirname "$0")/.." && pwd)/up.sh"',
					'"$(cd "$(dirname "$0")" && cd .. && pwd)/upped.sh"',
					'cp "$(dirname "$0")/hook.sh.orig" .',
					'cp "$(dirname "$0")/run.sh-v1" .',
				].join("\n"),
			).map((said) => said.replace(/^.*: names (\S+) beside it.*$/, "$1")),
		).toEqual(["linked.sh", "braced.sh", "quiet.sh", "emptied.sh"]);
	});

	it("follows a script by its whole name, never a shorter one inside it", () => {
		const path = script("cp words.sh.orig run.sh-v1 /tmp\n", [
			"words.sh",
			"run.sh",
		]);
		expect(importsOf(path)).toEqual([]);
	});

	// What `--changed` compares is the checkout's tracked files, so a name
	// reaching past it has nothing there to follow.
	it("follows no script outside the root it reads names from", () => {
		const path = script("bash ../beyond.sh\n", ["../beyond.sh"]);
		const code = scriptsAsText(dirname(path)).load(path) ?? "";
		expect(code, "the module, importing nothing past its root").not.toMatch(
			/^import /m,
		);
	});

	// A vitest started with a root of its own compares that root's files,
	// so a loader given none reads names from there, not this checkout.
	it("reads names from the root vite resolved, when given none", () => {
		const path = script("bash beside.sh\n", ["beside.sh"]);
		const loader = scriptsAsText();
		loader.configResolved({ root: dirname(path) });
		expect(loader.load(path) ?? "", "the module").toMatch(
			/^import "\.\/beside\.sh";$/m,
		);
	});

	// A folder can carry a script's ending; importing one would fail every
	// test that imports the script naming it.
	it("follows no folder whose name ends as a script's does", () => {
		const path = script('source "$(dirname "$0")/lib.sh/x"\nls lib.sh\n', [
			["lib.sh/x", ""],
		]);
		expect(importsOf(path)).toEqual([]);
		expect(isShellScript(join(dirname(path), "lib.sh")), "the folder").toBe(
			false,
		);
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
