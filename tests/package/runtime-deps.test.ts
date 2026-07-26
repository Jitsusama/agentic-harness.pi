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

/**
 * What to declare for each pi specifier the code imports.
 *
 * The two spellings are the same packages: pi renamed them and its
 * loader still aliases the old names, which is what this repo
 * imports. The manifest names the packages that exist, because a
 * peer nobody can resolve is not a promise, and because the old
 * ones are published deprecated.
 */
const PI_PEER_FOR = new Map([
	["@mariozechner/pi-ai", "@earendil-works/pi-ai"],
	["@mariozechner/pi-coding-agent", "@earendil-works/pi-coding-agent"],
	["@mariozechner/pi-tui", "@earendil-works/pi-tui"],
	["typebox", "typebox"],
	["@sinclair/typebox", "typebox"],
]);

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
		peerDependencies?: Record<string, string>;
		peerDependenciesMeta?: Record<string, { optional?: boolean }>;
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

	describe("what pi provides", () => {
		/** The pi packages this code actually imports, by manifest name. */
		const needed = new Set<string>();
		for (const dir of ["lib", "extensions"]) {
			for (const file of sourceFiles(join(root, dir))) {
				for (const line of readFileSync(file, "utf8").split("\n")) {
					const pkg = runtimeImport(line);
					const peer = pkg ? PI_PEER_FOR.get(pkg) : undefined;
					if (peer) needed.add(peer);
				}
			}
		}
		const peers = manifest.peerDependencies ?? {};
		const meta = manifest.peerDependenciesMeta ?? {};

		it("finds the pi imports, so a pass means something", () => {
			expect(needed.has("@earendil-works/pi-coding-agent")).toBe(true);
		});

		it("declares them as peers, which is what pi's own docs ask for", () => {
			// A peer says what the host must provide, which is exactly the
			// relationship: pi hands these to an extension at load time.
			const missing = [...needed].filter((pkg) => peers[pkg] === undefined);
			expect(missing).toEqual([]);
		});

		it("asks for any version, because the host decides which", () => {
			// A range would be a claim about which pi this runs under, and
			// the answer is whichever one loaded it.
			const pinned = [...needed].filter((pkg) => peers[pkg] !== "*");
			expect(pinned).toEqual([]);
		});

		it("marks every one optional, or a consumer gets a second pi", () => {
			// Measured, not assumed. npm installs a root package's peers
			// unless they are optional, and pi runs `npm install --omit=dev`
			// on a git install. Declaring these without the optional flag
			// pulled 189 packages into a test tree, including a deprecated
			// copy of pi's whole runtime three minor versions behind. A
			// second copy of pi's modules is a different copy, and the
			// instanceof checks in its APIs stop holding.
			const required = [...needed].filter(
				(pkg) => meta[pkg]?.optional !== true,
			);
			expect(required).toEqual([]);
		});

		it("keeps them installed here, so types resolve", () => {
			// pnpm does not install optional peers, and typecheck needs the
			// real declarations on disk. Naming the same packages in both
			// lists is also what keeps pnpm from deciding a peer is missing
			// and installing its own: it finds them already satisfied.
			const absent = [...needed].filter(
				(pkg) => !forDevelopmentOnly.has(pkg) && !declared.has(pkg),
			);
			expect(absent).toEqual([]);
		});
	});
});
