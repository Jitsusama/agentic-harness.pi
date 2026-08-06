/**
 * A hand-written declaration says what its module actually exports.
 *
 * A `.d.mts` beside a `.mjs` is the one kind of type in this project
 * that nothing checks. The compiler reads the declaration and never
 * looks at the module, so a rename on one side leaves the other
 * describing something that is not there, and every caller keeps
 * typechecking cleanly against a lie. That is the exact failure the
 * declaration was added to prevent, so it needs a gate of its own.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every hand-written declaration under lib, with its module. */
async function pairs(): Promise<{ types: string; module: string }[]> {
	const found: { types: string; module: string }[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
			} else if (entry.name.endsWith(".d.mts")) {
				found.push({ types: path, module: path.replace(/\.d\.mts$/, ".mjs") });
			}
		}
	}
	await walk(join(ROOT, "lib"));
	return found;
}

/** The names a declaration file claims to export. */
function declared(source: string): string[] {
	const names = new Set<string>();
	const patterns = [
		/^export\s+(?:declare\s+)?(?:const|function|class)\s+([A-Za-z0-9_$]+)/gm,
		/^export\s+(?:interface|type)\s+([A-Za-z0-9_$]+)/gm,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			if (match[1] !== undefined) names.add(match[1]);
		}
	}
	return [...names];
}

/** Names that exist only in the types, since a type is not a value. */
function typeOnly(source: string): Set<string> {
	const names = new Set<string>();
	for (const match of source.matchAll(
		/^export\s+(?:interface|type)\s+([A-Za-z0-9_$]+)/gm,
	)) {
		if (match[1] !== undefined) names.add(match[1]);
	}
	return names;
}

describe("a declaration beside a plain module", () => {
	it("declares only values the module actually exports", async () => {
		const missing: string[] = [];
		for (const pair of await pairs()) {
			const source = readFileSync(pair.types, "utf8");
			const types = typeOnly(source);
			const real = await import(pathToFileURL(pair.module).href);
			for (const name of declared(source)) {
				if (types.has(name)) continue;
				if (!(name in real)) missing.push(`${pair.types} declares ${name}`);
			}
		}

		expect(missing).toEqual([]);
	});

	it("declares every value the module exports", async () => {
		// The other direction, which is how a declaration goes stale
		// without anybody noticing: the module grows an export, the
		// declaration does not, and the TypeScript caller cannot see it
		// at all.
		const undeclared: string[] = [];
		for (const pair of await pairs()) {
			const names = declared(readFileSync(pair.types, "utf8"));
			const real = await import(pathToFileURL(pair.module).href);
			for (const name of Object.keys(real)) {
				if (!names.includes(name)) {
					undeclared.push(`${pair.module} exports ${name}`);
				}
			}
		}

		expect(undeclared).toEqual([]);
	});

	it("finds the pair it was written for", async () => {
		// A walk that matched nothing would pass both cases above
		// forever.
		const found = await pairs();

		expect(found.map((one) => one.types.replace(ROOT, ""))).toContain(
			"/lib/subagent/runpi/journal.d.mts",
		);
	});
});
