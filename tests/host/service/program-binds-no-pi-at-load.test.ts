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
 * or not, or in a function called where it is written, since those run
 * as the module loads; pi-host loads the program so, from its own top
 * level, once its hook is in place. A `require` made by
 * `const name = createRequire(...)` is a load under that name, wherever
 * the file makes it.
 *
 * What must not load is each optional peer in package.json, pi's scope
 * and typebox alike: an install may lack any of them, and the hook
 * redirects pi's scope alone. A bare name is followed no further when
 * it is node's own or a declared dependency, which can't reach an
 * optional peer it doesn't declare.
 *
 * An `import()` inside a function runs when the function does, and is
 * not followed. So the walk can't see one that a function called
 * elsewhere at load runs ahead of the configuration check, such as a
 * callback a call at load runs. pi-host.test.ts is the check for that:
 * it runs pi-host against a missing pi install with each optional peer
 * and dev dependency refused, as a production install lacks them. The
 * walk fails closed on what it does read: a load that doesn't name its
 * module by a plain string; a createRequire other than one called to
 * make a named `const`, renamed, named by a string or passed on; a
 * require made and exported; a require name used other than in a call;
 * a relative import of a file that isn't there; a bare name that is
 * neither node's nor a dependency (the package's own name among them,
 * which reaches its own code unwalked); or a file that won't parse.
 * The createRequire and require checks read the whole file, functions
 * included, since a require made in a function can be handed back to
 * run at load. Each fails the test, by file, line and why, rather than
 * being passed over.
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

/** The nodes whose body runs at once when called where they are written. */
const CALLABLE_HERE = new Set([
	"FunctionExpression",
	"ArrowFunctionExpression",
]);

/** A load the walk can't follow: the line it is on, and why. */
interface Unread {
	readonly line: number;
	readonly why: string;
}

/** What a file loads as it loads, and the loads it can't read. */
interface Loads {
	readonly specifiers: readonly string[];
	readonly unread: readonly Unread[];
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

/** Each child node of `node`, past its location and comments. */
function childrenOf(node: Record<string, unknown>): unknown[] {
	return Object.entries(node)
		.filter(([key]) => key !== "loc" && !key.endsWith("Comments"))
		.map(([, value]) => value);
}

/** Whether `node` is an identifier spelled `name`. */
function isNamed(node: unknown, name: string): boolean {
	return isRecord(node) && node.type === "Identifier" && node.name === name;
}

/**
 * The identifiers of a program that only name a thing rather than use
 * it: a property read by name, a key, and the names an import binds.
 */
function namingOnly(node: Record<string, unknown>): unknown[] {
	if (
		(node.type === "MemberExpression" ||
			node.type === "OptionalMemberExpression") &&
		node.computed !== true
	)
		return [node.property];
	if (
		(node.type === "ObjectProperty" ||
			node.type === "ObjectMethod" ||
			node.type === "ClassMethod" ||
			node.type === "ClassProperty" ||
			node.type === "ClassAccessorProperty") &&
		node.computed !== true
	)
		return [node.key];
	// A private member's name, `#name`, which nothing but its class reads.
	if (node.type === "PrivateName") return [node.id];
	return [];
}

/**
 * The names each `const name = createRequire(...)` gives a require,
 * anywhere in the file, and the lines of any other use of createRequire
 * or of those names, which can't be followed: a createRequire renamed
 * on import or as it is destructured, read without a call, or called
 * other than to make a named `const`, or named by a string; a require
 * exported, passed on, copied or read other than by calling it.
 */
function requiresMade(program: unknown): {
	readonly names: ReadonlySet<string>;
	readonly unread: readonly Unread[];
} {
	const unread: Unread[] = [];
	const names = new Set(["require"]);
	const calls = new Set<unknown>();
	const made = new Set<unknown>();
	const named = new Set<unknown>();
	const bindings = new Set<unknown>();
	const gather = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const each of node) gather(each);
			return;
		}
		if (!isRecord(node)) return;
		if (
			node.type === "ExportNamedDeclaration" &&
			isRecord(node.declaration) &&
			Array.isArray(node.declaration.declarations)
		)
			for (const declarator of node.declaration.declarations)
				if (isRecord(declarator) && callsCreateRequire(declarator.init))
					unread.push({
						line: lineOf(declarator),
						why: "a require made here is exported",
					});
		if (
			node.type === "VariableDeclarator" &&
			isRecord(node.id) &&
			node.id.type === "Identifier" &&
			typeof node.id.name === "string" &&
			callsCreateRequire(node.init)
		) {
			names.add(node.id.name);
			made.add(node.init);
			bindings.add(node.id);
		}
		if (node.type === "CallExpression") {
			calls.add(node.callee);
			if (isRecord(node.callee) && node.callee.type === "MemberExpression")
				calls.add(node.callee.property);
		}
		if (
			node.type === "ImportSpecifier" &&
			isNamed(node.imported, "createRequire") &&
			isNamed(node.local, "createRequire")
		)
			bindings.add(node.imported).add(node.local);
		if (
			node.type === "ObjectProperty" &&
			node.shorthand === true &&
			isNamed(node.key, "createRequire") &&
			isNamed(node.value, "createRequire")
		)
			bindings.add(node.key).add(node.value);
		for (const each of namingOnly(node)) named.add(each);
		for (const child of childrenOf(node)) gather(child);
	};
	gather(program);
	const check = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const each of node) check(each);
			return;
		}
		if (!isRecord(node)) return;
		if (callsCreateRequire(node) && !made.has(node))
			unread.push({
				line: lineOf(node),
				why: "createRequire called other than to make a named const",
			});
		if (node.type === "StringLiteral" && node.value === "createRequire")
			unread.push({
				line: lineOf(node),
				why: "createRequire named by a string",
			});
		if (
			node.type === "Identifier" &&
			typeof node.name === "string" &&
			!bindings.has(node) &&
			!calls.has(node)
		) {
			if (node.name === "createRequire")
				unread.push({
					line: lineOf(node),
					why: "createRequire renamed, read or passed on",
				});
			else if (names.has(node.name) && !named.has(node))
				unread.push({
					line: lineOf(node),
					why: `${node.name} used other than in a call`,
				});
		}
		for (const child of childrenOf(node)) check(child);
	};
	check(program);
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
	const unread: Unread[] = [...requires.unread];
	const runsNow = new Set<unknown>();
	const load = (node: Record<string, unknown>, from: unknown): void => {
		const specifier = moduleNamed(from);
		if (specifier === undefined)
			unread.push({
				line: lineOf(node),
				why: "a load not naming its module by a plain string",
			});
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
		if (node.type === "CallExpression" || node.type === "NewExpression")
			for (const callee of calledHere(node.callee)) runsNow.add(callee);
		const inner = later || (RUNS_LATER.has(node.type) && !runsNow.has(node));
		for (const child of childrenOf(node)) visit(child, inner);
	};
	visit(program.body, false);
	return { specifiers, unread };
}

/**
 * The function a call runs where it is written: the callee itself, or
 * the function whose `call` or `apply` it is.
 */
function calledHere(callee: unknown): unknown[] {
	if (!isRecord(callee)) return [];
	if (typeof callee.type === "string" && CALLABLE_HERE.has(callee.type))
		return [callee];
	const invoked =
		callee.type === "MemberExpression" &&
		(isNamed(callee.property, "call") || isNamed(callee.property, "apply"));
	return invoked ? calledHere(callee.object) : [];
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
		for (const { line, why } of loads.unread)
			unfollowed.push(`${file}:${line}: ${why}`);
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

/** The distinct lines of `unread`, in order. */
function linesOf(unread: readonly Unread[]): number[] {
	return [...new Set(unread.map(({ line }) => line))].sort((a, b) => a - b);
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
			'(() => {\n\tvoid import("iife-arrow");\n})();',
			'await (async function () {\n\tawait import("iife-function");\n})();',
			'(function () {\n\trequire("iife-call");\n}).call(this);',
			'const later2 = function () {\n\treturn import("named-later");\n};',
			"const here = import.meta.dirname;",
			"const ok = module.require;",
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
				"iife-arrow",
				"iife-function",
				"iife-call",
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
		expect(linesOf(unread)).toEqual([3, 5, 8]);
		expect(unread.find(({ line }) => line === 3)?.why).toBe(
			"a load not naming its module by a plain string",
		);
	});

	it("fails on a createRequire or a require it can't follow by name, by its line", () => {
		const source = [
			'import { createRequire as make } from "node:module";',
			'import { createRequire } from "node:module";',
			"const { createRequire: made } = module;",
			"const held = module.createRequire;",
			"const load = createRequire(import.meta.url);",
			"const copied = load;",
			"use(require);",
			'load("followed");',
			'import { "createRequire" as named } from "node:module";',
			'const fromString = module["createRequire"](import.meta.url);',
			"export const shared = createRequire(import.meta.url);",
			'function resolveLater() { return createRequire(import.meta.url).resolve("x"); }',
			'{\n\tconst { createRequire } = module;\n\tconst short = createRequire(import.meta.url);\n\tshort("short");\n}',
			'class Held {\n\t#require(id) {\n\t\treturn id;\n\t}\n\tuse() {\n\t\treturn this.#require("x");\n\t}\n}',
		].join("\n");
		const { specifiers, unread } = loadsIn(source);
		expect(specifiers).toEqual([
			"node:module",
			"node:module",
			"followed",
			"node:module",
			"short",
		]);
		expect(linesOf(unread)).toEqual([1, 3, 4, 6, 7, 9, 10, 11, 12]);
		expect(unread.find(({ line }) => line === 11)?.why).toBe(
			"a require made here is exported",
		);
		expect(unread.find(({ line }) => line === 7)?.why).toBe(
			"require used other than in a call",
		);
	});
});
