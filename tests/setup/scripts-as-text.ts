/**
 * Shell scripts imported as their text, so a test can import the script
 * it runs and `--changed` follows an edit to that script alone to it.
 *
 * vitest keeps a test's dependency only when the import's id names a
 * file that exists, query included, so vite's own `?raw` names
 * `it.sh?raw` and is dropped. A loader for the plain `.sh` keeps the id
 * the file's own path, which is what `--changed` compares. A script
 * that sources another from beside it imports that one too, so an edit
 * to what it sources reaches the same tests.
 */
import { readFileSync } from "node:fs";

/**
 * A line sourcing a script from the sourcing one's folder, by `source`
 * or `.`, as `"$(dirname "${BASH_SOURCE[0]}")/x.sh"` names it.
 */
const SOURCED = /^\s*(?:source|\.)\s+"\$\(dirname "[^"]+"\)\/([\w.-]+\.sh)"/gm;

/** The module for a script whose text is `text`. */
function asModule(text: string): string {
	const sourced = [...text.matchAll(SOURCED)].map(
		(found) => `import "./${found[1]}";\n`,
	);
	return `${sourced.join("")}export default ${JSON.stringify(text)};\n`;
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
			if (!id.endsWith(".sh")) return null;
			return asModule(readFileSync(id, "utf8"));
		},
	};
}
