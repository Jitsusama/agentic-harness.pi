/**
 * Shell scripts imported as their text, so a test can import the script
 * it runs and `--changed` follows an edit to that script alone to it.
 *
 * vitest keeps a test's dependency only when the import's id names a
 * file that exists, query included, so vite's own `?raw` names
 * `it.sh?raw` and is dropped. A loader for the plain script keeps the id
 * the file's own path, which is what `--changed` compares. A script
 * that names another imports that one too, so an edit to it reaches the
 * same tests: any script there is that its code names by a path, from
 * its own folder or from the checkout's root, and any shell program
 * with no ending beside it that it names at all. Following too much
 * only runs a test more; following too little runs none.
 */
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout's root, which a script run from there names its own from. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A script named by a path, from wherever it opens, after anything but
 * a name or a variable's `$`: `x.sh`, `lib/x.sh`, `../guard.bash`,
 * `.common.sh`, or `scripts/x.sh` from the root.
 */
const NAMED = /(?<![\w.$-])((?:[\w.-]+\/)*[\w.-]+\.(?:sh|bash))\b/g;

/** The script's own path: `$0` or `$BASH_SOURCE`, braced, quoted or not. */
const ITSELF = String.raw`"?(?:\$0|\$\{0\}|\$BASH_SOURCE|\$\{BASH_SOURCE(?:\[0\])?\})"?`;

/**
 * A script named from beside the naming one, in a way that can mean
 * nothing else: after the folder of the script's own path, as
 * `$(dirname "$0")/`, `$(cd "$(dirname "$0")" && pwd)/` or
 * `${BASH_SOURCE%/*}/`. The folder of any other path, as
 * `$(dirname "$config")`, is another folder.
 */
const BESIDE = new RegExp(
	String.raw`(?:\$\(dirname ${ITSELF}\)|\$\(cd "?\$\(dirname ${ITSELF}\)"? && pwd\)|\$\{BASH_SOURCE(?:\[0\])?%\/\*\})\/((?:[\w.-]+\/)*[\w.-]+\.(?:sh|bash))\b`,
	"g",
);

/** How much of a file is read for its shebang, a line far shorter. */
const SHEBANG_BYTES = 256;

/** A line that is only a comment. */
const COMMENT = /^\s*#/;

/** What a shell script's file name ends in. */
const SCRIPT = new Set([".sh", ".bash"]);

/**
 * A shebang naming a shell, directly or through env and its options, as
 * `#!/bin/sh`, `#!/usr/bin/env -S bash -eu` and a store path's bash do.
 */
const SHELL = /^#!\s*\S*\/(?:env\s+(?:-\S+\s+)*)?(?:ba|da|k|z)?sh\b/;

/** `text` with its lines that are only comments left out. */
function codeOf(text: string): string {
	return text
		.split("\n")
		.filter((line) => !COMMENT.test(line))
		.join("\n");
}

/**
 * Whether the file at `path` is a shell script: a file, not a folder,
 * ending in `.sh` or `.bash`, or one with no ending whose shebang names
 * a shell, as the ssh guard's wrappers are.
 */
export function isShellScript(path: string): boolean {
	const ending = extname(path);
	if (!(SCRIPT.has(ending) || ending === "")) return false;
	if (!(statSync(path, { throwIfNoEntry: false })?.isFile() ?? false))
		return false;
	return SCRIPT.has(ending) || SHELL.test(firstLine(path));
}

/** The first line of the file at `path`, read no further than a shebang. */
function firstLine(path: string): string {
	const head = Buffer.alloc(SHEBANG_BYTES);
	const file = openSync(path, "r");
	try {
		const read = readSync(file, head, 0, SHEBANG_BYTES, 0);
		return head.toString("utf8", 0, read).split("\n", 1)[0] ?? "";
	} finally {
		closeSync(file);
	}
}

/** The shell programs with no ending in `folder`, by name. */
function programsIn(folder: string): string[] {
	return readdirSync(folder)
		.filter((name) => extname(name) === "")
		.filter((name) => isShellScript(join(folder, name)))
		.sort();
}

/** `name` as a whole word in `code`, a name or a path's last part. */
function saysWord(code: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w.$-])${escaped}(?![\\w.-])`).test(code);
}

/**
 * The scripts that the script at `path`, whose text is `text`, names in
 * its code and that exist, as absolute paths, itself left out: each
 * named by a path, read from its folder first and then from `root`, and
 * each shell program with no ending beside it named at all.
 */
export function followedBy(
	path: string,
	text: string,
	root: string = ROOT,
): string[] {
	const folder = dirname(path);
	const code = codeOf(text);
	const byPath = [...code.matchAll(NAMED)].flatMap((found) => {
		const name = found[1] ?? "";
		const there = [resolve(folder, name), resolve(root, name)].find((file) =>
			existsSync(file),
		);
		return there === undefined ? [] : [there];
	});
	const programs = programsIn(folder)
		.filter((name) => saysWord(code, name))
		.map((name) => join(folder, name));
	return [...new Set([...byPath, ...programs])].filter(
		(file) => file !== path && isShellScript(file),
	);
}

/**
 * What in `text`, a script at `path`, names a script beside it that
 * isn't there, each as its line and the name: in a way that can mean
 * only beside it, so a slip of the name would otherwise leave the
 * script it meant out of every test's reach with no word.
 */
export function unfollowedNames(path: string, text: string): string[] {
	const folder = dirname(path);
	return codeOf(text)
		.split("\n")
		.flatMap((line) =>
			[...line.matchAll(BESIDE)]
				.map((found) => found[1] ?? "")
				.filter((name) => !existsSync(resolve(folder, name)))
				.map(
					(name) =>
						`${line.trim()}: names ${name} beside it, which isn't there to follow`,
				),
		);
}

/**
 * Whether `id` names a script the loader reads as text: a file's own
 * path, with no query and not a plugin's module, which opens with a
 * NUL and names no file.
 */
function isScript(id: string): boolean {
	return !id.includes("?") && isAbsolute(id) && isShellScript(id);
}

/** How the module for a script in `folder` imports `file`. */
function specifier(folder: string, file: string): string {
	const path = relative(folder, file);
	return path.startsWith("../") ? path : `./${path}`;
}

/** The module for the script at `path`, its follows read from `root`. */
function asModule(path: string, root: string): string {
	const text = readFileSync(path, "utf8");
	const imports = followedBy(path, text, root).map(
		(file) => `import ${JSON.stringify(specifier(dirname(path), file))};\n`,
	);
	return `${imports.join("")}export default ${JSON.stringify(text)};\n`;
}

/**
 * The loader, to be given to each vitest project, since none inherits
 * the root's; `root` is where a script's names from the root are read
 * from, this checkout's but in a test of the loader.
 */
export function scriptsAsText(root: string = ROOT): {
	name: string;
	enforce: "pre";
	load(id: string): string | null;
} {
	return {
		name: "scripts-as-text",
		// Ahead of every other plugin, so none claims a script first.
		enforce: "pre",
		load(id) {
			return isScript(id) ? asModule(id, root) : null;
		},
	};
}
