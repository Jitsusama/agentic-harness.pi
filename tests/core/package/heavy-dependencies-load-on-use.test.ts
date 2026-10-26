/**
 * Importing this package loads none of its heaviest dependencies.
 *
 * pi loads every extension at startup, and an extension that imports
 * any entry point here pays for whatever that entry point imports
 * eagerly. googleapis bundles a client for every Google API and jsdom
 * an entire browser DOM; together with puppeteer and defuddle they
 * cost a pi process most of a second and close to 300 MB before any
 * tool runs, for work most sessions never ask for. Each loads on the
 * first call that needs it instead.
 *
 * This imports every export of the package, and every barrel of
 * lib/core (what core exported before it was folded in here), in a
 * child node, with a resolve hook watching, and fails if any of them
 * reaches one of these packages' entry points. The child loads them
 * through jiti, as pi does, since node's own type stripping refuses
 * some of the TypeScript pi accepts.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * The pi package whose jiti the child loads through, as pi itself would:
 * its real path, since pnpm keeps jiti beside pi's real folder, not
 * beside the link to it.
 */
const PI = realpathSync(
	join(
		ROOT,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"package.json",
	),
);

/** Every barrel under lib/core, as a path from the package's root. */
function coreBarrels(): string[] {
	return readdirSync(join(ROOT, "lib", "core"), {
		recursive: true,
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile() && entry.name === "index.ts")
		.map((entry) => `./${relative(ROOT, join(entry.parentPath, entry.name))}`);
}

/** The entry point each heavy package resolves to when loaded whole. */
const HEAVY: Record<string, RegExp> = {
	googleapis: /\/googleapis\/build\/src\/index\.js$/,
	"puppeteer-core": /\/puppeteer-core\/lib\/puppeteer\/puppeteer-core\.js$/,
	jsdom: /\/jsdom\/lib\/api\.js$/,
	defuddle: /\/defuddle\/dist\/node\.js$/,
};

/** Every export of the package and every barrel of lib/core, as URLs. */
function everyEntryPoint(): string[] {
	const exports: Record<string, string> = JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf8"),
	).exports;
	return [...Object.values(exports), ...coreBarrels()].map(
		(target) => new URL(target, `file://${ROOT}/`).href,
	);
}

/** Which heavy packages a child node reaches by importing entries through jiti. */
function loadedByImporting(entries: string[]): string[] {
	const script = `
		import { createRequire, registerHooks } from "node:module";
		const heavy = ${JSON.stringify(Object.fromEntries(Object.entries(HEAVY).map(([name, pattern]) => [name, pattern.source])))};
		const loaded = new Set();
		registerHooks({
			resolve(specifier, context, next) {
				const result = next(specifier, context);
				for (const [name, pattern] of Object.entries(heavy)) {
					if (new RegExp(pattern).test(result.url)) loaded.add(name);
				}
				return result;
			},
		});
		const { createJiti } = createRequire(${JSON.stringify(PI)})("jiti");
		const jiti = createJiti(${JSON.stringify(`file://${ROOT}/`)});
		for (const entry of ${JSON.stringify(entries)}) await jiti.import(entry);
		console.log(JSON.stringify([...loaded].sort()));
	`;
	const output = execFileSync(
		process.execPath,
		["--input-type=module", "-e", script],
		{ cwd: ROOT, encoding: "utf8" },
	);
	return JSON.parse(output.trim().split("\n").at(-1) ?? "[]");
}

describe("heavy dependencies", () => {
	// jiti compiles some 700 files cold in the child, which took 19 s
	// on a loaded machine; a hang still fails, later.
	it("stay unloaded when every entry point is imported", {
		timeout: 120_000,
	}, () => {
		expect(loadedByImporting(everyEntryPoint())).toEqual([]);
	});

	// Without this the check above would pass just as happily if the
	// hook never saw what jiti loads.
	it("are seen when something does load one", { timeout: 60_000 }, () => {
		expect(loadedByImporting(["jsdom"])).toEqual(["jsdom"]);
	});
});
