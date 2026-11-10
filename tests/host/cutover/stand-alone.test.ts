/**
 * The cutover's programs run under node alone, from the install: pi
 * provides its own packages to what it loads, but nothing provides them
 * to `node scripts/host-cutover.ts`, and an install holds only the
 * package's own dependencies. One import of pi at runtime, anywhere
 * under a program, ends it before it starts ("Cannot find package
 * '@earendil-works/pi-ai'"), as it did the first dry run from an
 * install. So this follows each program's runtime imports through the
 * package and finds none of pi's.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");

/** The programs a person runs with node alone. */
const PROGRAMS = [
	"scripts/host-cutover.ts",
	"scripts/host-release.ts",
	"scripts/host-rollout.ts",
];

/** What pi provides to what it loads, and only to that. */
const PI = /^@(?:earendil-works|mariozechner)\/pi-/;

/** An import or re-export, and what it names. */
const IMPORT =
	/^\s*(?:import|export)\s+(type\s+)?(\{[^}]*\}|[^;'"]*?)\s*from\s+["']([^"']+)["']/gm;

/** Whether an import brings nothing at runtime: `import type`, or only `type` names. */
function typeOnly(typeWord: string | undefined, names: string): boolean {
	if (typeWord) return true;
	const inner = /^\{([^}]*)\}$/.exec(names.trim())?.[1];
	if (inner === undefined) return false;
	const each = inner
		.split(",")
		.map((one) => one.trim())
		.filter((one) => one !== "");
	return each.length > 0 && each.every((one) => one.startsWith("type "));
}

/** Each chain from `program` to an import of pi, file by file. */
function piImports(program: string): string[] {
	const seen = new Set<string>();
	const found: string[] = [];
	const walk = (file: string, chain: readonly string[]) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const [, typeWord, names = "", spec = ""] of readFileSync(
			file,
			"utf8",
		).matchAll(IMPORT)) {
			if (typeOnly(typeWord, names)) continue;
			if (PI.test(spec)) found.push([...chain, spec].join(" -> "));
			if (!spec.startsWith(".")) continue;
			const next = resolve(dirname(file), spec);
			if (existsSync(next)) walk(next, [...chain, relative(ROOT, next)]);
		}
	};
	walk(resolve(ROOT, program), [program]);
	return found;
}

describe("the cutover's programs", () => {
	for (const program of PROGRAMS)
		it(`${program} runs under node alone, importing nothing of pi's`, () => {
			expect(piImports(program)).toEqual([]);
		});
});
