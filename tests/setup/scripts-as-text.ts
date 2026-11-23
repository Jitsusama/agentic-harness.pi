/**
 * Shell scripts imported as their text, so a test can import the script
 * it runs and `--changed` follows an edit to that script alone to it.
 *
 * vitest keeps a test's dependency only when the import's id names a
 * file that exists, query included, so vite's own `?raw` names
 * `it.sh?raw` and is dropped. A loader for the plain `.sh` keeps the id
 * the file's own path, which is what `--changed` compares.
 */
import { readFileSync } from "node:fs";

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
			return `export default ${JSON.stringify(readFileSync(id, "utf8"))};\n`;
		},
	};
}
