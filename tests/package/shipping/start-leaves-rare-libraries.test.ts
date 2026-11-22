/**
 * What every pi loads at start leaves out libraries only a rare call needs.
 *
 * Every pi loads each extension, and with it everything that extension
 * imports, whether the session ever calls on it or not. Measured alone
 * on 21 November (node 22), vscode-jsonrpc with the language server
 * protocol held 2.0 MB of heap and 21 MB resident and took 140 ms to
 * load, for the lsp tool a few sessions call; zod held 2.1 MB and 9 MB,
 * for the host's protocol, which a pi outside a host reads only when it
 * opens, adopts, lists or closes a conversation in one. Each loads on
 * first use instead, through `loadOnce`, so this walks what loads at
 * start: every static import from each extension's entry, leaving out
 * `import type` and `export type`, which load nothing, and dynamic
 * imports, which load when called.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The libraries that load on first use, with the call that needs each. */
const ON_FIRST_USE = new Map([
	["vscode-jsonrpc", "the lsp tool's first server"],
	["vscode-languageserver-protocol", "the lsp tool's first server"],
	["zod", "the first request to a host's control socket"],
]);

/** A static import or re-export that loads its module: not `type` only. */
const STATIC =
	/(?:^|[\n;])\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g;

/** Source without comments, so an import a comment quotes is not one. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The specifiers a source loads as it loads. */
function loads(source: string): string[] {
	return [...code(source).matchAll(STATIC)].flatMap(([, specifier]) =>
		specifier === undefined ? [] : [specifier],
	);
}

/** The package a bare specifier names, or undefined for node's own. */
function packageOf(specifier: string): string | undefined {
	if (specifier.startsWith("node:")) return undefined;
	const parts = specifier.split("/");
	return (
		specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)
	).join("/");
}

/** Each file's specifiers, read once however many extensions reach it. */
const read = new Map<string, string[]>();

function loadsOf(file: string): string[] {
	let found = read.get(file);
	if (found === undefined) {
		found = loads(readFileSync(file, "utf8"));
		read.set(file, found);
	}
	return found;
}

/** The file a relative specifier names, as jiti finds it. */
function fileOf(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	return [base, `${base}.ts`, join(base, "index.ts")].find(
		(path) => existsSync(path) && statSync(path).isFile(),
	);
}

/**
 * Each library in `wanted` an entry reaches at start, with the chain of
 * files that reaches it, shortest first, and the call that wants it.
 */
function reached(entry: string, wanted: ReadonlyMap<string, string>): string[] {
	const chains = new Map([[entry, [entry]]]);
	const queue = [entry];
	const found: string[] = [];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		const chain = chains.get(file) ?? [file];
		for (const specifier of loadsOf(file)) {
			if (specifier.startsWith(".")) {
				const next = fileOf(file, specifier);
				if (next === undefined || chains.has(next)) continue;
				chains.set(next, [...chain, next]);
				queue.push(next);
			} else {
				const library = packageOf(specifier);
				const needed = library === undefined ? undefined : wanted.get(library);
				if (needed !== undefined)
					found.push(
						`${[...chain.map((path) => relative(ROOT, path)), specifier].join(" → ")}, wanted only by ${needed}`,
					);
			}
		}
	}
	return found;
}

describe("what loads at start", () => {
	it("leaves out each library only a rare call needs", () => {
		const extensions = join(ROOT, "extensions");
		const found = readdirSync(extensions)
			.map((name) => join(extensions, name, "index.ts"))
			.filter((entry) => existsSync(entry))
			.flatMap((entry) => reached(entry, ON_FIRST_USE));
		expect(found, "chains from an extension to a first-use library").toEqual(
			[],
		);
	});

	it("counts value imports and re-exports, not types or later imports", () => {
		const source = [
			'import { a } from "./a.ts";',
			'import type { B } from "./b.ts";',
			'import {\n\ttype C,\n} from "./c.ts";',
			'export { d } from "./d.ts";',
			'export type { E } from "./e.ts";',
			'import "./f.ts";',
			'const g = loadOnce(() => import("./g.ts"));',
			'// import { h } from "./h.ts";',
			'/** import { i } from "./i.ts"; */',
		].join("\n");
		expect(loads(source)).toEqual(["./a.ts", "./c.ts", "./d.ts", "./f.ts"]);
	});
});
