/**
 * The scripts, and the modules the library starts as children of their
 * own, load no pi package, however far their imports reach.
 *
 * A user service, the launcher and mycelium run these under plain node
 * from the harness's production install, which carries none of pi's
 * packages, since pi is only an optional peer. So a runtime import of
 * one anywhere a script's imports lead fails the script before it does
 * anything: on 11 November a restart's variables, imported from the
 * spawner, took pi with them into the session records, and every script
 * that reads those failed each minute. A type-only import is erased
 * before it runs, so it may stay.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPTS = join(ROOT, "scripts");

/** The scripts that bind pi themselves before they load what imports it. */
const BINDS_PI: Record<string, string> = {
	"pi-host.ts":
		"binds every pi import to the host's own install before loading the host",
};

/** Each import's specifier, and whether the whole statement is a type's. */
const STATIC =
	/(?:^|\n)\s*(?:import|export)(\s+type)?\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const BARE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']/g;

/** The specifiers `source` loads when it runs. */
function loaded(source: string): string[] {
	return [
		...[...source.matchAll(STATIC)]
			.filter(([, typeOnly]) => typeOnly === undefined)
			.map(([, , specifier]) => specifier ?? ""),
		...[...source.matchAll(BARE)].map(([, specifier]) => specifier ?? ""),
		...[...source.matchAll(DYNAMIC)].map(([, specifier]) => specifier ?? ""),
	];
}

/**
 * Each pi package a script loads, as `file specifier (by way of ...)`,
 * following its relative imports through every file they reach.
 */
function piReached(script: string): string[] {
	const found: string[] = [];
	const cameFrom = new Map<string, string | undefined>([[script, undefined]]);
	const todo = [script];
	const way = (file: string): string => {
		const steps: string[] = [];
		for (let at: string | undefined = file; at; at = cameFrom.get(at)) {
			steps.unshift(relative(ROOT, at));
		}
		return steps.join(" -> ");
	};
	for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
		for (const specifier of loaded(readFileSync(file, "utf8"))) {
			if (specifier.startsWith("@earendil-works/")) {
				found.push(`${relative(ROOT, file)} ${specifier} (${way(file)})`);
			} else if (specifier.startsWith(".")) {
				const next = join(dirname(file), specifier);
				if (!cameFrom.has(next) && existsSync(next)) {
					cameFrom.set(next, file);
					todo.push(next);
				}
			}
		}
	}
	return found;
}

it("reaches no runtime import of pi from any script", () => {
	const scripts = readdirSync(SCRIPTS)
		.filter((name) => /\.(?:ts|mjs)$/.test(name) && !(name in BINDS_PI))
		.map((name) => join(SCRIPTS, name));
	expect(scripts.length, "the scripts folder holds scripts").toBeGreaterThan(0);
	expect(scripts.flatMap(piReached)).toEqual([]);
});

/** A module the library starts on its own, named beside the one starting it. */
const STARTED =
	/\bnew URL\(\s*["'](\.{1,2}\/[^"']+\.(?:mjs|ts))["'],\s*import\.meta\.url/g;

/** The library's sources, every `.ts` and `.mjs` under `lib/`. */
function librarySources(dir = join(ROOT, "lib")): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return librarySources(path);
		return /\.(?:ts|mjs)$/.test(entry.name) ? [path] : [];
	});
}

// 25 November: every council's reviewers failed to start, since their
// supervisor, which plain node runs, reached pi-tui through the quit
// asker the session's owner imports.
it("reaches no runtime import of pi from a module the library starts on its own", () => {
	const started = new Set(
		librarySources().flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(STARTED)]
				.map(([, specifier]) => join(dirname(file), specifier ?? ""))
				.filter((path) => existsSync(path)),
		),
	);
	expect(
		[...started].map((path) => relative(ROOT, path)),
		"the council's supervisor is among them",
	).toContain("lib/subagent/runpi/supervisor.mjs");
	expect([...started].flatMap(piReached)).toEqual([]);
});

it("tells what a module loads from what it only names for types", () => {
	const source = [
		'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
		'import { type Model } from "./model.ts";',
		'export type { Text } from "@earendil-works/pi-tui";',
		'import "./side-effect.ts";',
		'export { later } from "../later.ts";',
		'const tui = () => import("@earendil-works/pi-tui");',
	].join("\n");
	expect(loaded(source)).toEqual([
		"./model.ts",
		"../later.ts",
		"./side-effect.ts",
		"@earendil-works/pi-tui",
	]);
});
