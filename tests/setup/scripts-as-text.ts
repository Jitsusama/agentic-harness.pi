/**
 * Shell scripts imported as their text, so a test can import the script
 * it runs and `--changed` follows an edit to that script alone to it.
 *
 * vitest keeps a test's dependency only when the import's id names a
 * file that exists, query included, so vite's own `?raw` names
 * `it.sh?raw` and is dropped. A loader for the plain script keeps the id
 * the file's own path, which is what `--changed` compares. A script
 * that sources or runs another from beside it imports that one too, so
 * an edit to it reaches the same tests.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

/**
 * A script named from the naming one's own folder, in quotes: after
 * `$(dirname ...)`, `$(cd ... && pwd)` or a `$here` set from it, as
 * `"$(dirname "${BASH_SOURCE[0]}")/x.sh"` and `"$here/../guard.bash"`
 * name one.
 */
const BESIDE = /(?:\)|\$here)\/((?:\.\.\/)*[\w.-]+\.(?:sh|bash))"/g;

/** A line sourcing a file, by `source` or `.`. */
const SOURCING = /^\s*(?:source|\.)\s+\S/;

/** What a shell script's file name ends in. */
const SCRIPT = new Set([".sh", ".bash"]);

/**
 * The scripts that the script at `path`, whose text is `text`, names
 * from beside it and that exist, as paths from its folder.
 */
export function besideOf(path: string, text: string): string[] {
	const named = [...text.matchAll(BESIDE)].map((found) => found[1] ?? "");
	return [...new Set(named)].filter((name) =>
		existsSync(resolve(dirname(path), name)),
	);
}

/**
 * The lines of `text`, a script at `path`, that source a file the loader
 * can't follow: a source of a file named in some other way.
 */
export function unfollowedSources(path: string, text: string): string[] {
	return text
		.split("\n")
		.filter((line) => SOURCING.test(line))
		.filter((line) => besideOf(path, line).length === 0);
}

/** Whether the file at `id` is a script the loader reads as text. */
function isScript(id: string): boolean {
	if (id.includes("?")) return false;
	const ending = extname(id);
	if (SCRIPT.has(ending)) return true;
	// The ssh guard's wrappers have no ending, only a shebang.
	return (
		ending === "" &&
		(statSync(id, { throwIfNoEntry: false })?.isFile() ?? false) &&
		readFileSync(id, "utf8").startsWith("#!")
	);
}

/** The module for the script at `path`. */
function asModule(path: string): string {
	const text = readFileSync(path, "utf8");
	const beside = besideOf(path, text).map(
		(name) => `import "${name.startsWith(".") ? name : `./${name}`}";\n`,
	);
	return `${beside.join("")}export default ${JSON.stringify(text)};\n`;
}

/** The loader, to be given to each vitest project, since none inherits the root's. */
export function scriptsAsText(): {
	name: string;
	enforce: "pre";
	load(id: string): string | null;
} {
	return {
		name: "scripts-as-text",
		// Before vite's own loading, which reads any file it is asked for
		// as JavaScript.
		enforce: "pre",
		load(id) {
			return isScript(id) ? asModule(id) : null;
		},
	};
}
