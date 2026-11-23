/**
 * The model providers' SDKs stay out of the typecheck.
 *
 * `openai`, `@anthropic-ai/sdk` and `@google/genai` reach `tsc` only
 * through pi-ai's declarations, for provider options and adapters this
 * package never uses. tsconfig.json's `paths` maps each, and every path
 * under it, to `lib/internal/provider-sdks.d.ts`, which exports nothing,
 * so `tsc` reads that rather than their 199,000 lines.
 *
 * The bargain holds while nothing here depends on an SDK itself: a type
 * taken from one then fails the typecheck, rather than typing whatever
 * it names as `any`. So the rule checks three things: each mapping is
 * there, the stub is there and empty (a mapping whose file is gone
 * falls through to node_modules and reads the SDK again), and
 * package.json names none of the SDKs, since a package that does means
 * to use its types and should drop the mapping.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The SDKs pi-ai's declarations import, and nothing here uses. */
const SDKS = ["openai", "@anthropic-ai/sdk", "@google/genai"];

/** The stub every SDK entry maps to. */
const STUB = "./lib/internal/provider-sdks.d.ts";

/** A JSON file at the root, read as the plain JSON it is today. */
function rootJson(name: string): Record<string, unknown> {
	const text = readFileSync(join(ROOT, name), "utf8");
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(
			`this rule reads ${name} as plain JSON, so a comment or trailing ` +
				"comma there needs a JSONC parser here first",
			{ cause: error },
		);
	}
}

/** tsconfig.json's `paths`. */
function paths(): Record<string, unknown> {
	const { compilerOptions } = rootJson("tsconfig.json");
	const found =
		typeof compilerOptions === "object" && compilerOptions !== null
			? Reflect.get(compilerOptions, "paths")
			: undefined;
	return typeof found === "object" && found !== null ? { ...found } : {};
}

/** Every package package.json depends on, of every kind. */
function dependencies(): string[] {
	const manifest = rootJson("package.json");
	return [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	].flatMap((kind) => {
		const listed = manifest[kind];
		return typeof listed === "object" && listed !== null
			? Object.keys(listed)
			: [];
	});
}

describe("the model providers' SDKs", () => {
	it.each(SDKS)("has the typecheck read nothing for %s", (sdk) => {
		const mapped = paths();
		expect(mapped[sdk], sdk).toEqual([STUB]);
		expect(mapped[`${sdk}/*`], `${sdk}/*`).toEqual([STUB]);
	});

	it("maps them to a stub that is there and exports nothing", () => {
		const stub = readFileSync(join(ROOT, STUB), "utf8");
		const code = stub.replace(/\/\*[\s\S]*?\*\//g, "").trim();
		expect(code).toBe("export {};");
	});

	it("are none of this package's own dependencies", () => {
		const own = dependencies().filter((name) => SDKS.includes(name));
		expect(
			own,
			"a package depended on here means to use its types: drop its " +
				"mapping in tsconfig.json and this rule's entry for it",
		).toEqual([]);
	});
});
