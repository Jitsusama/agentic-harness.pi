/**
 * Relative imports name the file that exists: `./x.ts`, not `./x.js`.
 *
 * pi loads this package from source through jiti, and jiti resolves
 * `./x.js` by first asking Node, which fails and builds an error with a
 * stack trace, then probing `x.js.js`, `x.js.mjs`, `x.js.ts` and a
 * dozen more before it lands on `x.ts`. Across a startup that is
 * hundreds of thousands of failed stats and thrown errors. Naming the
 * real file makes the first probe hit, and took loading every
 * extension from 5.9 s to 1.2 s.
 *
 * A specifier is only rewritten when the `.ts` file it stands for
 * exists and no real `.js` file does, so genuine JavaScript stays
 * addressed as it is.
 *
 * Run it directly (Node strips the types), from the package root:
 *
 *   node scripts/ts-import-specifiers.ts [dir ...]
 *
 * With no directories it rewrites everything pi or the tests load. It
 * is safe to run again at any time, including after a merge brings in
 * code written the old way.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Where a relative specifier can appear: import, export, import() and vi.mock(). */
const SPECIFIER =
	/((?:\bfrom|\bimport|\bvi\.mock)\s*\(?\s*)(["'])(\.\.?\/[^"'\n]+?)\.js\2/g;

/** The directories this package's own code lives in. */
export const SOURCE_DIRS = ["extensions", "lib", "packs", "tests", "scripts"];

/** A relative `.js` specifier in `source` that stands for a `.ts` file. */
export interface StaleSpecifier {
	line: number;
	specifier: string;
}

function standsForTs(file: string, stem: string): boolean {
	const base = resolve(dirname(file), stem);
	return existsSync(`${base}.ts`) && !existsSync(`${base}.js`);
}

/** Every relative `.js` specifier in a file that should name its `.ts` file. */
export function staleSpecifiers(
	file: string,
	source: string,
): StaleSpecifier[] {
	const stale: StaleSpecifier[] = [];
	for (const match of source.matchAll(SPECIFIER)) {
		const stem = match[3];
		if (stem === undefined || !standsForTs(file, stem)) continue;
		const line = source.slice(0, match.index).split("\n").length;
		stale.push({ line, specifier: `${stem}.js` });
	}
	return stale;
}

/** The file's source with each stale specifier naming its `.ts` file. */
export function rewriteSpecifiers(file: string, source: string): string {
	return source.replace(
		SPECIFIER,
		(whole, lead: string, quote: string, stem: string) =>
			standsForTs(file, stem) ? `${lead}${quote}${stem}.ts${quote}` : whole,
	);
}

/** Every TypeScript file under the given directories, skipping node_modules. */
export function sourceFiles(
	root: string,
	dirs: readonly string[] = SOURCE_DIRS,
): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(ts|tsx|mts)$/.test(entry)) files.push(path);
		}
	};
	for (const dir of dirs) {
		const path = join(root, dir);
		if (existsSync(path)) walk(path);
	}
	return files;
}

function main(): void {
	const root = process.cwd();
	const dirs = process.argv.length > 2 ? process.argv.slice(2) : SOURCE_DIRS;
	let files = 0;
	let specifiers = 0;
	for (const file of sourceFiles(root, dirs)) {
		const source = readFileSync(file, "utf8");
		const stale = staleSpecifiers(file, source).length;
		if (stale === 0) continue;
		writeFileSync(file, rewriteSpecifiers(file, source));
		files += 1;
		specifiers += stale;
	}
	console.log(`rewrote ${specifiers} specifiers in ${files} files`);
}

if (import.meta.main) main();
