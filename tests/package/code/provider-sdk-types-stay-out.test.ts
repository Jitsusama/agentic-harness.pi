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
 *
 * It also pins where pi-ai's declarations take types from the SDKs, and
 * which packages they import at all. What reads as `any` under the stub
 * is only what those places type from an SDK: OpenAI's tool choice and
 * service tier options, a pre-built Anthropic client, and the adapters
 * under `api/`, none of which this package passes or calls. A pi
 * upgrade that takes SDK types somewhere new, or brings in another
 * heavy package, fails here, so someone checks what now reads as `any`
 * (or maps the newcomer) rather than the typecheck quietly loosening or
 * growing. A new use of an SDK type inside a file already listed is
 * past what this sees.
 *
 * `pnpm check` runs the tests a change reaches, and an edit to
 * tsconfig.json or the stub alone reaches none of these, so there only
 * the typecheck stands guard: a dropped mapping costs time, not checks,
 * until the full suite in CI runs this. Rerunning every test on such an
 * edit means changing `vitest.config.ts`, which the merge gate counts
 * as host code and holds for an hour of host tests.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The SDKs pi-ai's declarations import, and nothing here uses. */
const SDKS = ["openai", "@anthropic-ai/sdk", "@google/genai"];

/** The stub every SDK entry maps to. */
const STUB = "./lib/internal/provider-sdks.d.ts";

/** Where pi-ai's declarations live, through pnpm's link. */
const PI_AI_DIST = join(
	realpathSync(join(ROOT, "node_modules", "@earendil-works", "pi-ai")),
	"dist",
);

/**
 * Each pi-ai declaration that imports from an SDK, and what it imports,
 * as of pi-ai 1.4.0.
 */
const SDK_IMPORTS_IN_PI_AI: Record<string, string[]> = {
	"api/anthropic-messages.d.ts": ["@anthropic-ai/sdk"],
	"api/azure-openai-responses.d.ts": [
		"openai/resources/responses/responses.js",
	],
	"api/google-shared.d.ts": ["@google/genai"],
	"api/openai-codex-responses.d.ts": [
		"openai/resources/responses/responses.js",
	],
	"api/openai-completions.d.ts": [
		"openai",
		"openai/resources/chat/completions.js",
	],
	"api/openai-responses-shared.d.ts": [
		"openai/resources/responses/responses.js",
	],
	"api/openai-responses.d.ts": ["openai/resources/responses/responses.js"],
};

/** Packages pi-ai's declarations may import besides the SDKs: small ones. */
const LIGHT_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-telemetry",
	"typebox",
];

/** A bare specifier in an import, an `import()` type or a types reference. */
const BARE_SPECIFIER =
	/(?:\bfrom\s+|\bimport\s*\(\s*|reference\s+types=)["']([^"'./][^"']*)["']/g;

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

/** Every declaration file under a directory, by its path from there. */
function declarations(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
		(entry) => /\.d\.[cm]?ts$/.test(entry),
	);
}

/** The bare specifiers a declaration imports, Node's own left out. */
function bareSpecifiers(file: string): string[] {
	const text = readFileSync(join(PI_AI_DIST, file), "utf8");
	return [...text.matchAll(BARE_SPECIFIER)]
		.map(([, specifier]) => specifier)
		.filter((specifier) => !specifier.startsWith("node:"));
}

/** The package a specifier names: a scope and a name, or a name. */
function packageOf(specifier: string): string {
	const parts = specifier.split("/");
	const kept = specifier.startsWith("@") ? 2 : 1;
	return parts.slice(0, kept).join("/");
}

/** Whether a specifier is an SDK or a path under one. */
function isSdk(specifier: string): boolean {
	return SDKS.includes(packageOf(specifier));
}

describe("the model providers' SDKs", () => {
	it.each(SDKS)("maps %s and every path under it to the stub", (sdk) => {
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

	it("reach pi-ai's declarations only where they did", () => {
		const found: Record<string, string[]> = {};
		for (const file of declarations(PI_AI_DIST).sort()) {
			const sdk = [...new Set(bareSpecifiers(file).filter(isSdk))].sort();
			if (sdk.length > 0) found[file] = sdk;
		}
		expect(
			found,
			"pi-ai takes SDK types somewhere new: check that nothing this " +
				"package uses now reads as any under the stub, then update this list",
		).toEqual(SDK_IMPORTS_IN_PI_AI);
	});

	it("leave pi-ai's declarations importing only small packages", () => {
		const heavy = new Set(
			declarations(PI_AI_DIST)
				.flatMap(bareSpecifiers)
				.map(packageOf)
				.filter((name) => !SDKS.includes(name))
				.filter((name) => !LIGHT_PACKAGES.includes(name)),
		);
		expect(
			[...heavy].sort(),
			"pi-ai's declarations import a package this rule hasn't weighed: " +
				"map it to the stub if nothing here uses its types, or list it " +
				"as small",
		).toEqual([]);
	});
});
