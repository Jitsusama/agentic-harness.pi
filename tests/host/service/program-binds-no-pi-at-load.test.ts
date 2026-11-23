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
 * imports nothing from host/, so `pnpm check`'s `vitest --changed`
 * never picks it for a change there.
 *
 * This file imports the program, so a change anywhere in its graph
 * picks it. A change to scripts/pi-host.ts itself, which no test can
 * import without starting a host, picks every test, since the entry is
 * among vitest.config.ts's RERUN_EVERYTHING.
 *
 * It walks what loads from pi-host's entry as it loads. Each file is
 * read as node runs it, its types stripped by node's own
 * stripTypeScriptTypes, so a type-only import is let through exactly
 * when node erases it: `import type` is, but `import { type A }` is
 * left as `import {}`, which still loads its module. The stripped code
 * is parsed, and the walk follows each static import and re-export,
 * and each `import()` or `require()` outside any function, in a block
 * or not, since those run as the module loads; pi-host loads the
 * program so, from its own top level, once its hook is in place.
 *
 * An `import()` inside a function runs when the function does, and is
 * not followed. So the walk can't see one that a function called at
 * load runs ahead of the configuration check; pi-host.test.ts, which
 * runs pi-host against a missing install, is the check for that. The
 * walk fails closed on what it does read: a load that doesn't name its
 * module by a plain string, a relative import of a file that isn't
 * there, or a file that won't parse fails the test rather than being
 * passed over.
 */

import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { EXIT_MISCONFIGURED } from "../../../host/service/program.ts";
import { isRecord } from "../../../lib/internal/record.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The scope pi-host's hook resolves from the host's own install. */
const PI_SCOPE = "@earendil-works/";

/** pi-host's entry. */
const ENTRY = "scripts/pi-host.ts";

/** What pi-host loads once its hook is registered, which the walk must reach. */
const LOADED_BY_ENTRY = ["host/service/program.ts", "host/service/run.ts"];

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

/** The module a call loads as it runs, when it is `import()` or `require()`. */
function calledLoad(
	node: Record<string, unknown>,
): { readonly from: unknown } | undefined {
	if (node.type === "ImportExpression") return { from: node.source };
	if (node.type !== "CallExpression" || !isRecord(node.callee)) return;
	const { callee } = node;
	const loads =
		callee.type === "Import" ||
		(callee.type === "Identifier" && callee.name === "require");
	if (!loads) return;
	return {
		from: Array.isArray(node.arguments) ? node.arguments[0] : undefined,
	};
}

/** What TypeScript code loads as it loads, once node strips its types. */
function loadsIn(source: string): Loads {
	// Stripping blanks types in place, so lines stay the source's.
	const { program } = parse(stripTypeScriptTypes(source), {
		sourceType: "module",
	});
	const specifiers: string[] = [];
	const unread: number[] = [];
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
		const called = later ? undefined : calledLoad(node);
		if (called) load(node, called.from);
		const inner = later || RUNS_LATER.has(node.type);
		for (const [key, value] of Object.entries(node))
			if (key !== "loc" && !key.endsWith("Comments")) visit(value, inner);
	};
	visit(program.body, false);
	return { specifiers, unread };
}

/** What the walk from pi-host's entry found. */
interface Walk {
	/** Each value from pi's scope bound at load, with the chain of files that reaches it. */
	readonly piBound: readonly string[];
	/** Each load or relative import the walk couldn't follow, by file and line. */
	readonly unfollowed: readonly string[];
	/** Every file the walk reached. */
	readonly reached: ReadonlySet<string>;
}

/** Walk what loads from pi-host's entry as it loads. */
function walkFromEntry(): Walk {
	const piBound: string[] = [];
	const unfollowed: string[] = [];
	const reached = new Set<string>();
	const walk = (file: string, chain: string[]): void => {
		if (reached.has(file)) return;
		reached.add(file);
		const { specifiers, unread } = loadsIn(
			readFileSync(join(ROOT, file), "utf8"),
		);
		for (const line of unread) unfollowed.push(`${file}:${line}`);
		for (const specifier of specifiers) {
			if (specifier.startsWith(PI_SCOPE))
				piBound.push(`${[...chain, file].join(" → ")} → ${specifier}`);
			else if (specifier.startsWith(".")) {
				const next = relative(ROOT, join(ROOT, dirname(file), specifier));
				if (existsSync(join(ROOT, next))) walk(next, [...chain, file]);
				else unfollowed.push(`${file}: ${specifier} is not there`);
			}
		}
	};
	walk(ENTRY, []);
	return { piBound, unfollowed, reached };
}

describe("loading the host program", () => {
	it("binds nothing from pi, so a missing install is refused with exit 78", () => {
		expect(EXIT_MISCONFIGURED).toBe(78);
		const { piBound, unfollowed, reached } = walkFromEntry();
		expect(
			unfollowed,
			"name each module by a plain string, and name a file that is there",
		).toEqual([]);
		expect(LOADED_BY_ENTRY.filter((file) => !reached.has(file))).toEqual([]);
		expect(
			piBound,
			"import these after loadHostPi, with import() in a function, as the engine does kept history",
		).toEqual([]);
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
		].join("\n");
		const { specifiers, unread } = loadsIn(source);
		expect(specifiers).toEqual(["read"]);
		expect(unread).toEqual([3, 5]);
	});
});
