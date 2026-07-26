/**
 * Everything imported at runtime has to be installed at runtime.
 *
 * A user installed this package and it died on `Cannot find module
 * 'pixelmatch'`. That one was a stale node_modules rather than a
 * bad manifest, but it showed how little stands between a
 * misplaced dependency and a package that cannot load: nothing in
 * lint, typecheck or the suite reads the manifest, because
 * everything is installed on a developer's machine either way. A
 * dependency in the wrong list is invisible here and fatal there.
 *
 * So this reads what the code imports and checks the manifest
 * promises it. Static, because installing from a clean tree in CI
 * would catch the same thing far more slowly and only there.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url).pathname;

/**
 * Packages pi provides to an extension at runtime.
 *
 * Declaring these as dependencies is wrong, not merely
 * unnecessary: a second copy of pi's own modules is a different
 * copy, and the instanceof checks stop working.
 */
const PROVIDED_BY_PI = /^@mariozechner\/pi-|^(?:@sinclair\/)?typebox$/;

/**
 * Note on the two spellings of typebox.
 *
 * pi's own extension docs list `typebox` among the packages it
 * provides, and pi depends on it. `@sinclair/typebox` is the older
 * name, which pi's loader rewrites, so both resolve at runtime and
 * this repo uses both in different files. Neither belongs in
 * dependencies, for the same reason pi's own modules do not.
 */

/** Files that ship and run, as opposed to files that test them. */
function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourceFiles(path));
			continue;
		}
		if (entry.endsWith(".ts") || entry.endsWith(".mjs")) found.push(path);
	}
	return found;
}

/**
 * The bare package a line imports for its values, if any.
 *
 * Type-only imports are left out on purpose: they vanish before
 * the code runs, so a type from a devDependency is honest. The
 * inline `import { type X }` form still counts, since the
 * statement itself survives.
 */
function runtimeImport(line: string): string | undefined {
	if (/^\s*import\s+type\s/.test(line)) return undefined;
	const match =
		/^\s*(?:import|export)[^"']*from\s*["']([^"']+)["']/.exec(line) ??
		/^\s*import\s*["']([^"']+)["']/.exec(line) ??
		/\brequire\(\s*["']([^"']+)["']\s*\)/.exec(line);
	const specifier = match?.[1];
	if (!specifier) return undefined;
	if (specifier.startsWith(".") || specifier.startsWith("node:")) {
		return undefined;
	}
	// A subpath import still comes from its package: pngjs/browser
	// is satisfied by pngjs.
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? specifier);
}

describe("what ships can load", () => {
	const manifest = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const declared = new Set(Object.keys(manifest.dependencies ?? {}));
	const forDevelopmentOnly = new Set(
		Object.keys(manifest.devDependencies ?? {}),
	);

	const imported = new Map<string, string[]>();
	for (const dir of ["lib", "extensions"]) {
		for (const file of sourceFiles(join(root, dir))) {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				const pkg = runtimeImport(line);
				if (!pkg || PROVIDED_BY_PI.test(pkg)) continue;
				imported.set(pkg, [
					...(imported.get(pkg) ?? []),
					file.slice(root.length),
				]);
			}
		}
	}

	it("finds the imports at all, so a pass means something", () => {
		// Without this, a broken scanner reports a clean package.
		expect(imported.has("puppeteer-core")).toBe(true);
		expect(imported.size).toBeGreaterThan(3);
	});

	it("declares every package it imports as a dependency", () => {
		const undeclared = [...imported.entries()]
			.filter(([pkg]) => !declared.has(pkg))
			.map(([pkg, where]) => `${pkg} (imported by ${where[0]})`);
		expect(undeclared).toEqual([]);
	});

	it("does not run on anything listed for development only", () => {
		// The failure this catches is silent locally, because a
		// devDependency is installed on the machine that wrote it and
		// absent on the machine that installs the package.
		const misplaced = [...imported.keys()]
			.filter((pkg) => forDevelopmentOnly.has(pkg) && !declared.has(pkg))
			.map((pkg) => `${pkg} is a devDependency but imported at runtime`);
		expect(misplaced).toEqual([]);
	});

	it("does not bundle its own copy of what pi provides", () => {
		const shadowed = [...declared].filter((pkg) => PROVIDED_BY_PI.test(pkg));
		expect(shadowed).toEqual([]);
	});
});
