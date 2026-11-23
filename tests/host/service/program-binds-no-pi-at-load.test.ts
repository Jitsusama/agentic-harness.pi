/**
 * Loading the host program binds nothing from pi, so a host whose pi
 * install is missing is refused with exit 78 rather than failing on an
 * import.
 *
 * pi-host resolves pi's modules from PI_PACKAGE_DIR, through a hook it
 * registers before it imports the program. With that install gone, any
 * value imported from pi's scope anywhere in the program's static
 * graph fails the import itself, with exit 1 and a stack, before the
 * program's configuration check can refuse the install with
 * EXIT_MISCONFIGURED. A unit names that status in
 * RestartPreventExitStatus, so the difference is a host that waits for
 * a fix against one systemd restarts every few seconds. Kept history's
 * static import did exactly that on 22 November, and the test that
 * runs pi-host (tests/scripts/pi-host.test.ts) didn't catch it: it
 * imported nothing from host/, so `pnpm check`'s `vitest --changed`
 * never picked it for a change there, and `pnpm test:host` doesn't run
 * it.
 *
 * So this file and pi-host.test.ts each import every module pi-host
 * imports itself, the program and what loads before the hook alike,
 * and a change anywhere those reach picks both; the walk fails when
 * pi-host imports a module either file doesn't. A change to
 * scripts/pi-host.ts itself, which no test can import without starting
 * a host, picks every test, since the entry is among vitest.config.ts's
 * RERUN_EVERYTHING.
 *
 * It walks what loads from pi-host's entry as it loads. Each file is
 * read as node runs it, its types stripped by node's own
 * stripTypeScriptTypes, so a type-only import is let through exactly
 * when node erases it: `import type` is, but `import { type A }` is
 * left as `import {}`, which still loads its module. The stripped code
 * is parsed, and the walk follows each static import and re-export,
 * and each `import()` or `require()` outside any function, in a block
 * or not, since those run as the module loads; pi-host loads the
 * program so, from its own top level, once its hook is in place. A
 * `require` made by createRequire is a load under whatever name it is
 * given.
 *
 * What must not load is each optional peer in package.json, pi's scope
 * and typebox alike: an install may lack any of them, and the hook
 * redirects pi's scope alone. A bare name is followed no further when
 * it is node's own or a declared dependency, which can't reach an
 * optional peer it doesn't declare.
 *
 * An `import()` inside a function runs when the function does, and is
 * not followed. So the walk can't see one that a function called at
 * load runs ahead of the configuration check; pi-host.test.ts, which
 * runs pi-host against a missing install, is the check for that. The
 * walk fails closed on what it does read: a load that doesn't name its
 * module by a plain string, a createRequire it can't follow, a relative
 * import of a file that isn't there, a bare name that is neither node's
 * nor a dependency (the package's own name among them, which reaches
 * its own code unwalked), or a file that won't parse fails the test,
 * by file and line, rather than being passed over.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { builtinModules, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import "../../../host/service/compile-cache.ts";
import "../../../host/service/pi-resolution.ts";
import { EXIT_MISCONFIGURED } from "../../../host/service/program.ts";
import "../../../host/service/run.ts";
import "../../../lib/internal/fence/compile-cache-place.ts";
import { isRecord } from "../../../lib/internal/record.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** pi-host's entry. */
const ENTRY = "scripts/pi-host.ts";

/** What pi-host loads once its hook is registered, which the walk must reach. */
const LOADED_BY_ENTRY = ["host/service/program.ts", "host/service/run.ts"];

/**
 * How long the walk may take: it parses every file the host loads, about
 * 7 s on a machine at a load average of 130, past vitest's 5 s default.
 */
const WALK_TIME = 60_000;

/** The tests that must import every module pi-host imports, to be picked for a change to one. */
const GUARDS = [
	"tests/host/service/program-binds-no-pi-at-load.test.ts",
	"tests/scripts/pi-host.test.ts",
];

/** The nodes whose body runs when they are called, not as the module loads. */
const RUNS_LATER = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ObjectMethod",
	"ClassMethod",
	"ClassPrivateMethod",
]);

/** What a file loads as it loads, and the lines of loads it can't read. */
interface Loads {
	readonly specifiers: readonly string[];
	readonly unread: readonly number[];
}

/** The module a load names, when it names one by a plain string. */
function moduleNamed(node: unknown): string | undefined {
	if (!isRecord(node)) return undefined;
	if (node.type === "StringLiteral" && typeof node.value === "string")
		return node.value;
	if (
		node.type !== "TemplateLiteral" ||
		!Array.isArray(node.expressions) ||
		node.expressions.length > 0 ||
		!Array.isArray(node.quasis)
	)
		return undefined;
	const [quasi] = node.quasis;
	return isRecord(quasi) &&
		isRecord(quasi.value) &&
		typeof quasi.value.cooked === "string"
		? quasi.value.cooked
		: undefined;
}

/** The line a node starts on. */
function lineOf(node: Record<string, unknown>): number {
	const { loc } = node;
	return isRecord(loc) &&
		isRecord(loc.start) &&
		typeof loc.start.line === "number"
		? loc.start.line
		: 0;
}

/** The module a call loads as it runs, when it is `import()` or a call of a `require`. */
function calledLoad(
	node: Record<string, unknown>,
	requires: ReadonlySet<string>,
): { readonly from: unknown } | undefined {
	if (node.type === "ImportExpression") return { from: node.source };
	if (node.type !== "CallExpression" || !isRecord(node.callee)) return;
	const { callee } = node;
	const loads =
		callee.type === "Import" ||
		(callee.type === "Identifier" &&
			typeof callee.name === "string" &&
			requires.has(callee.name));
	if (!loads) return;
	return {
		from: Array.isArray(node.arguments) ? node.arguments[0] : undefined,
	};
}

/** Whether a node calls createRequire, by name or as a member. */
function callsCreateRequire(node: unknown): boolean {
	if (!isRecord(node) || node.type !== "CallExpression") return false;
	const { callee } = node;
	if (!isRecord(callee)) return false;
	const named = callee.type === "MemberExpression" ? callee.property : callee;
	return (
		isRecord(named) &&
		named.type === "Identifier" &&
		named.name === "createRequire"
	);
}

/**
 * The names each `const name = createRequire(...)` gives a require, and
 * the lines of every other createRequire, whose require can't be
 * followed.
 */
function requiresMade(program: unknown): {
	readonly names: ReadonlySet<string>;
	readonly unread: readonly number[];
} {
	const names = new Set(["require"]);
	const unread: number[] = [];
	const named = new Set<unknown>();
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const each of node) visit(each);
			return;
		}
		if (!isRecord(node)) return;
		if (
			node.type === "VariableDeclarator" &&
			isRecord(node.id) &&
			node.id.type === "Identifier" &&
			typeof node.id.name === "string" &&
			callsCreateRequire(node.init)
		) {
			names.add(node.id.name);
			named.add(node.init);
		}
		if (callsCreateRequire(node) && !named.has(node)) unread.push(lineOf(node));
		for (const [key, value] of Object.entries(node))
			if (key !== "loc" && !key.endsWith("Comments")) visit(value);
	};
	visit(program);
	return { names, unread };
}

/** What TypeScript code loads as it loads, once node strips its types. */
function loadsIn(source: string): Loads {
	// Stripping blanks types in place, so lines stay the source's.
	const { program } = parse(stripTypeScriptTypes(source), {
		sourceType: "module",
	});
	const specifiers: string[] = [];
	const requires = requiresMade(program.body);
	const unread: number[] = [...requires.unread];
	const load = (node: Record<string, unknown>, from: unknown): void => {
		const specifier = moduleNamed(from);
		if (specifier === undefined) unread.push(lineOf(node));
		else specifiers.push(specifier);
	};
	const visit = (node: unknown, later: boolean): void => {
		if (Array.isArray(node)) {
			for (const each of node) visit(each, later);
			return;
		}
		if (!isRecord(node) || typeof node.type !== "string") return;
		if (
			node.type === "ImportDeclaration" ||
			((node.type === "ExportNamedDeclaration" ||
				node.type === "ExportAllDeclaration") &&
				node.source)
		)
			load(node, node.source);
		const called = later ? undefined : calledLoad(node, requires.names);
		if (called) load(node, called.from);
		const inner = later || RUNS_LATER.has(node.type);
		for (const [key, value] of Object.entries(node))
			if (key !== "loc" && !key.endsWith("Comments")) visit(value, inner);
	};
	visit(program.body, false);
	return { specifiers, unread };
}

/** What the walk from an entry found. */
interface Walk {
	/** Each optional peer bound at load, with the chain of files that reaches it. */
	readonly peerBound: readonly string[];
	/** Each load the walk couldn't follow, by file and line or by name. */
	readonly unfollowed: readonly string[];
	/** Every file the walk reached. */
	readonly reached: ReadonlySet<string>;
}

/** The names a manifest field lists, as its keys. */
function namesIn(field: unknown): readonly string[] {
	return isRecord(field) ? Object.keys(field) : [];
}

/** The package a bare specifier names, scoped or not. */
function packageOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? specifier);
}

/** Walk what loads from `entry` as it loads, in the package at `root`. */
function walkFrom(root: string, entry: string): Walk {
	const manifest: unknown = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	);
	const field = (name: string): unknown =>
		isRecord(manifest) ? manifest[name] : undefined;
	const meta = field("peerDependenciesMeta");
	const peers = new Set(
		namesIn(field("peerDependencies")).filter((name) => {
			const of = isRecord(meta) ? meta[name] : undefined;
			return isRecord(of) && of.optional === true;
		}),
	);
	const dependencies = new Set(namesIn(field("dependencies")));
	const builtins = new Set(builtinModules);
	const peerBound: string[] = [];
	const unfollowed: string[] = [];
	const reached = new Set<string>();
	const walk = (file: string, chain: string[]): void => {
		if (reached.has(file)) return;
		reached.add(file);
		let loads: Loads;
		try {
			loads = loadsIn(readFileSync(join(root, file), "utf8"));
		} catch (error) {
			unfollowed.push(`${file}: won't read: ${String(error)}`);
			return;
		}
		for (const line of loads.unread) unfollowed.push(`${file}:${line}`);
		for (const specifier of loads.specifiers) {
			if (specifier.startsWith(".")) {
				const next = relative(root, join(root, dirname(file), specifier));
				if (existsSync(join(root, next))) walk(next, [...chain, file]);
				else unfollowed.push(`${file}: ${specifier} is not there`);
				continue;
			}
			const name = packageOf(specifier);
			if (peers.has(name))
				peerBound.push(`${[...chain, file].join(" → ")} → ${specifier}`);
			else if (
				!specifier.startsWith("node:") &&
				!builtins.has(specifier) &&
				!dependencies.has(name)
			)
				unfollowed.push(
					`${file}: ${specifier} is neither node's nor a dependency`,
				);
		}
	};
	walk(entry, []);
	return { peerBound, unfollowed, reached };
}

/** The relative modules a file imports, resolved from the package root. */
function importedBy(file: string): ReadonlySet<string> {
	return new Set(
		loadsIn(readFileSync(join(ROOT, file), "utf8"))
			.specifiers.filter((specifier) => specifier.startsWith("."))
			.map((specifier) => relative(ROOT, join(ROOT, dirname(file), specifier))),
	);
}

describe("loading the host program", () => {
	it(
		"binds nothing from pi, so a missing install is refused with exit 78",
		() => {
			expect(EXIT_MISCONFIGURED).toBe(78);
			const { peerBound, unfollowed, reached } = walkFrom(ROOT, ENTRY);
			expect(
				unfollowed,
				"name each module by a plain string, as a file that is there, node's own or a dependency",
			).toEqual([]);
			expect(LOADED_BY_ENTRY.filter((file) => !reached.has(file))).toEqual([]);
			expect(
				peerBound,
				"import these after loadHostPi, with import() in a function, as the engine does kept history",
			).toEqual([]);
		},
		WALK_TIME,
	);

	it("is picked, with pi-host's own test, for a change to any module pi-host imports", () => {
		const wanted = [...importedBy(ENTRY)];
		expect(wanted).toEqual(expect.arrayContaining(LOADED_BY_ENTRY));
		for (const guard of GUARDS) {
			const imported = importedBy(guard);
			expect(
				wanted.filter((file) => !imported.has(file)),
				`import these in ${guard}`,
			).toEqual([]);
		}
	});

	it("names the chain to each optional peer, and fails on a bare name it can't place or a file it can't read", () => {
		const root = mkdtempSync(join(tmpdir(), "load-walk-"));
		try {
			const write = (file: string, text: string): void => {
				mkdirSync(dirname(join(root, file)), { recursive: true });
				writeFileSync(join(root, file), text);
			};
			write(
				"package.json",
				JSON.stringify({
					name: "self",
					dependencies: { yaml: "*" },
					peerDependencies: { "@earendil-works/pi-ai": "*", typebox: "*" },
					peerDependenciesMeta: {
						"@earendil-works/pi-ai": { optional: true },
						typebox: { optional: true },
					},
				}),
			);
			write(
				"entry.ts",
				[
					'import "./lib/a.ts";',
					'import { readFileSync } from "node:fs";',
					'import { join } from "path";',
					'import { parse } from "yaml";',
					'import "self/lib/a.ts";',
					'import "stranger";',
					'import "./broken.ts";',
				].join("\n"),
			);
			write(
				"lib/a.ts",
				[
					'import { complete } from "@earendil-works/pi-ai/dist/x.js";',
					'import { createRequire } from "node:module";',
					"const load = createRequire(import.meta.url);",
					'const { Type } = load("typebox");',
				].join("\n"),
			);
			write("broken.ts", "export const = ;");
			const { peerBound, unfollowed } = walkFrom(root, "entry.ts");
			expect(peerBound).toEqual([
				"entry.ts → lib/a.ts → @earendil-works/pi-ai/dist/x.js",
				"entry.ts → lib/a.ts → typebox",
			]);
			expect(unfollowed).toEqual([
				"entry.ts: self/lib/a.ts is neither node's nor a dependency",
				"entry.ts: stranger is neither node's nor a dependency",
				expect.stringMatching(/^broken\.ts: won't read: /),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads every spelling that loads a module as it loads, and none that loads later", () => {
		const source = [
			'import type { A } from "type-only";',
			'import { type B } from "empty-named";',
			'import { type C, d } from "named";',
			'import e, { f } from "default";',
			'import * as g from "namespace";',
			'import "bare";',
			'import {\n\th,\n\ti,\n} from "wrapped";',
			'import { /* why */ q } from "commented-braces";',
			'export { j } from "re-export";',
			'export * from "star";',
			'export * as k from "star-as";',
			'export type { L } from "type-re-export";',
			'export { type M } from "empty-re-export";',
			'const n = await import("at-top");',
			'const {\n\tp,\n} = await import("at-top-destructured");',
			'try {\n\tawait import("in-try");\n} catch {}',
			'if (n) {\n\tawait import("in-if");\n}',
			'void import("unawaited");',
			"await import(`template`);",
			'const r = require("required");',
			"const made = module.createRequire(import.meta.url);",
			'made("made-require");',
			'function madeLater() {\n\treturn made("made-later");\n}',
			'class S {\n\tstatic {\n\t\tvoid import("static-block");\n\t}\n\tlater() {\n\t\treturn import("method");\n\t}\n}',
			'async function later() {\n\tawait import("later");\n}',
			'const arrow = () => import("arrow");',
			"const here = import.meta.dirname;",
			'/** import { o } from "commented" */',
		].join("\n");
		const { specifiers, unread } = loadsIn(source);
		expect(unread).toEqual([]);
		expect([...specifiers].sort()).toEqual(
			[
				"empty-named",
				"named",
				"default",
				"namespace",
				"bare",
				"wrapped",
				"commented-braces",
				"re-export",
				"star",
				"star-as",
				"empty-re-export",
				"at-top",
				"at-top-destructured",
				"in-try",
				"in-if",
				"unawaited",
				"template",
				"required",
				"made-require",
				"static-block",
			].sort(),
		);
	});

	it("fails on a load at load time that doesn't name its module plainly, by its line", () => {
		const source = [
			'import { a } from "read";',
			"const name = a;",
			"await import(name);",
			// A template the reader sees, its `$` spelled so the code here has none.
			`if (a) {\n\tvoid import(\`${"$"}{name}-built\`);\n}`,
			"const later = () => import(name);",
			'createRequire(import.meta.url)("unnamed");',
		].join("\n");
		const { specifiers, unread } = loadsIn(source);
		expect(specifiers).toEqual(["read"]);
		expect([...unread].sort()).toEqual([3, 5, 8]);
	});
});
