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
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";

/**
 * A script named from the naming one's own folder, in quotes: after
 * `$(dirname ...)`, `$(cd ... && pwd)` or a `$here` set from it, as
 * `"$(dirname "${BASH_SOURCE[0]}")/x.sh"` and `"$here/../guard.bash"`
 * name one.
 */
const BESIDE =
	/(?:\$\(dirname [^)]*\)|\$\(cd .*? && pwd\)|\$here)\/((?:\.\.\/)*[\w.-]+\.(?:sh|bash))"/g;

/**
 * A script named by its path from the checkout's root, as a command run
 * from there names one, as `scripts/build.sh` from a script in scripts/.
 */
const FROM_ROOT = /(?<![\w.$/-])((?:[\w-]+\/)+)([\w.-]+\.(?:sh|bash))\b/g;

/** Any script a line names by a path, after a slash. */
const NAMED = /\/((?:\.\.\/)*[\w.-]+\.(?:sh|bash))\b/g;

/** A command sourcing a file, by `source` or `.`. */
const SOURCING = /^\s*(?:source|\.)\s+\S/;

/** A line that is only a comment. */
const COMMENT = /^\s*#/;

/** What a shell script's file name ends in. */
const SCRIPT = new Set([".sh", ".bash"]);

/** A shebang naming a shell, directly or through env. */
const SHELL = /^#!\s*\S*\/(?:env\s+)?(?:ba|da|k|z)?sh\b/;

/** `text` with its lines that are only comments left out. */
function codeOf(text: string): string {
	return text
		.split("\n")
		.filter((line) => !COMMENT.test(line))
		.join("\n");
}

/**
 * The scripts that the script at `path` names in `text`'s code from
 * beside it or from the root down to its folder, whether or not they
 * exist, as paths from its folder.
 */
function namedBeside(path: string, text: string): string[] {
	const folder = dirname(path);
	const code = codeOf(text);
	const beside = [...code.matchAll(BESIDE)].map((found) => found[1] ?? "");
	const fromRoot = [...code.matchAll(FROM_ROOT)]
		.filter((found) =>
			`${folder}${sep}`.endsWith(
				`${sep}${found[1] ?? "-"}`.replaceAll("/", sep),
			),
		)
		.map((found) => found[2] ?? "");
	return [...new Set([...beside, ...fromRoot])].filter(
		(name) => resolve(folder, name) !== path,
	);
}

/**
 * The scripts that the script at `path`, whose text is `text`, names
 * from beside it and that exist, as paths from its folder.
 */
export function besideOf(path: string, text: string): string[] {
	return namedBeside(path, text).filter((name) =>
		existsSync(resolve(dirname(path), name)),
	);
}

/**
 * What in `text`, a script at `path`, names a script the loader can't
 * follow, each as its line and why: a script beside it named in some
 * other way, a source of a file named in some other way, and a source
 * of one beside it that isn't there.
 */
export function unfollowedNames(path: string, text: string): string[] {
	const folder = dirname(path);
	return text
		.split("\n")
		.filter((line) => !COMMENT.test(line))
		.flatMap((line) => {
			const said = line.trim();
			const followed = besideOf(path, line);
			const missed = [...line.matchAll(NAMED)]
				.map((found) => found[1] ?? "")
				.filter((name) => resolve(folder, name) !== path)
				.filter((name) => existsSync(resolve(folder, name)))
				.filter((name) => !followed.includes(name));
			if (missed.length > 0)
				return [...new Set(missed)].map(
					(name) =>
						`${said}: names ${name}, beside it, in a way the loader can't follow`,
				);
			return line
				.split(/;\s/)
				.filter((command) => SOURCING.test(command))
				.flatMap((command) => {
					const named = namedBeside(path, command);
					if (named.length === 0)
						return [`${said}: a source named in a way the loader can't follow`];
					return named
						.filter((name) => !existsSync(resolve(folder, name)))
						.map((name) => `${said}: sources ${name}, which isn't there`);
				});
		});
}

/**
 * Whether the file at `path` is a shell script: one ending in `.sh` or
 * `.bash`, or one with no ending whose shebang names a shell, as the
 * ssh guard's wrappers are.
 */
export function isShellScript(path: string): boolean {
	const ending = extname(path);
	if (SCRIPT.has(ending)) return true;
	return (
		ending === "" &&
		(statSync(path, { throwIfNoEntry: false })?.isFile() ?? false) &&
		SHELL.test(readFileSync(path, "utf8").split("\n", 1)[0] ?? "")
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
		// Ahead of every other plugin, so none claims a script first.
		enforce: "pre",
		load(id) {
			return isScript(id) ? asModule(id) : null;
		},
	};
}
