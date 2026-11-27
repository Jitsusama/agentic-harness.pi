/**
 * A catch that drops its error says why.
 *
 * AGENTS.md asks it: every empty `catch {}` says why the error is safe
 * to ignore. biome's `noEmptyBlockStatements` is off, since an empty
 * block is often a failure the code means to pass by, so nothing held
 * the rule but review. A `catch {}` with no comment reads the same
 * whether its author weighed the failure or never saw it, and a failure
 * dropped that way gives no reason when it matters: the loop team
 * counted that among the classes that recur. So an empty catch holds a
 * comment saying why its failure can go, as every one but one did when
 * this was written.
 *
 * A statement's catch is read wherever `} catch {` or `} catch (error) {`
 * starts a line, as biome lays it out, a program written inside a string
 * included. A body holding code handles its error in some way and is
 * left alone.
 *
 * A promise's `.catch(() => {})` drops its error the same way, and so
 * does a `.catch(() => undefined)`, or one giving null, whose value
 * nothing keeps. Each says why in a comment on its line or one of the
 * two above, or on the line where its statement starts or one of the
 * two above that, since a chain or a wrapped call puts its reason above
 * its first line. A catch giving undefined or null whose statement
 * opens by binding, assigning or returning its value is left alone: it
 * turns the failure into an absence its caller handles.
 *
 * Every TypeScript and JavaScript file is read, since biome lays out
 * both alike. Any comment counts as a reason, apart from a doc comment's
 * lines, which say what a thing is: a rule that reads text can tell
 * that a reason is there, not that it is weighed.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { packageFiles } from "./package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The endings of the TypeScript and JavaScript files read. */
const SOURCE = /\.(?:[mc]?[jt]s|tsx)$/;

/** A statement's empty catch, as biome lays it out: nothing but space in its block. */
const EMPTY_CATCH =
	/^[ \t]*\}?[ \t]*catch\b[ \t]*(?:\([^)]*\))?[ \t]*\{\s*\}/gm;

/**
 * A promise's catch that drops its error, written on one line as biome
 * lays it out: its body empty, or giving only undefined or null.
 */
const PROMISE_DROP =
	/\.catch\(\s*(?:async\s*)?\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\)/;

/** A statement's first line that binds, assigns or returns its value. */
const KEEPS =
	/^\s*(?:(?:export\s+)?(?:const|let|var)\b|return\b|yield\b|[\w.$[\]]+\s*(?:\?\?|\|\||&&|[-+*/|&])?=(?![=>]))/;

/** A line that carries on the statement above it, by how it opens. */
const CARRIES_ON = /^[.)\]}?]/;

/** A line the statement below it carries on, by how it ends. */
const CARRIED_ON = /(?:[=(,[?]|=>|&&|\|\||\?\?)$/;

/** How long a read of every file may take on a busy machine. */
const WALK = { timeout: 60_000 };

/** The lines, counted from 1, of each catch in some source that is empty and says nothing. */
function silentCatches(text: string): number[] {
	const lines = text.split("\n");
	const dropped = lines.flatMap((line, at) => {
		const found = PROMISE_DROP.exec(line);
		if (found === null) return [];
		const start = statementStart(lines, at, found.index);
		const kept = !found[1]?.startsWith("{") && KEEPS.test(lines[start] ?? "");
		const near = [at, at - 1, at - 2, start, start - 1, start - 2];
		return kept || near.some((one) => says(lines[one] ?? "")) ? [] : [at + 1];
	});
	const empty = [...text.matchAll(EMPTY_CATCH)].map(
		(found) => text.slice(0, found.index).split("\n").length,
	);
	return [...empty, ...dropped].sort((a, b) => a - b);
}

/**
 * The line, counted from 0, where the statement holding a catch at
 * `column` of line `at` starts: up through the brackets it closes, and
 * past each line that carries on the one above.
 */
function statementStart(lines: string[], at: number, column: number): number {
	let depth = balance((lines[at] ?? "").slice(0, column));
	let start = at;
	while (start > 0) {
		const carried =
			depth < 0 ||
			CARRIES_ON.test((lines[start] ?? "").trimStart()) ||
			CARRIED_ON.test((lines[start - 1] ?? "").trimEnd());
		if (!carried) break;
		start -= 1;
		depth += balance(lines[start] ?? "");
	}
	return start;
}

/** The brackets some text opens, less those it closes. */
function balance(text: string): number {
	return (
		(text.match(/[([{]/g)?.length ?? 0) - (text.match(/[)\]}]/g)?.length ?? 0)
	);
}

/** Whether a line is a comment, or ends with one, other than a doc comment's. */
function says(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.startsWith("/**") || trimmed.startsWith("*")) return false;
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("/*") ||
		/\s\/\/\s/.test(line)
	);
}

describe("the package's catches", () => {
	it("tell an empty catch that says nothing from one that says why", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it finds what it is meant to and lets the rest by.
		expect(
			silentCatches("try {\n\tgo();\n} catch {}\n"),
			"an empty catch is found",
		).toEqual([3]);
		expect(
			silentCatches("try {\n\tgo();\n} catch (error) {\n}\n"),
			"one naming its error, closed on the next line, is found",
		).toEqual([3]);
		expect(
			silentCatches("try {\n\tgo();\n} catch {\n\t// Gone already.\n}\n"),
			"a comment inside says why",
		).toEqual([]);
		expect(
			silentCatches("try {\n\tgo();\n} catch {\n\treturn undefined;\n}\n"),
			"a body holding code is left to that code",
		).toEqual([]);
		expect(
			silentCatches("const text = 'try { go(); } catch {}';\n"),
			"a catch not starting its line is no statement's catch",
		).toEqual([]);
		expect(
			silentCatches("const page = `\ntry {\n\tgo();\n} catch {}\n`;\n"),
			"a program inside a string is read like code",
		).toEqual([4]);
		expect(
			silentCatches(
				"try {\n\ttry {\n\t\tgo();\n\t} catch {\n\t\tif (x) {\n\t\t}\n\t}\n} catch {}\n",
			),
			"a catch holding a block holds code, and a later empty one is found",
		).toEqual([8]);
		expect(
			silentCatches(
				"go().catch(() => {});\nwork\n\t.close()\n\t.catch((error) => {});\n",
			),
			"a promise's catch dropping its error is found, its name or none",
		).toEqual([1, 4]);
		expect(
			silentCatches(
				"// Gone already.\nconst going = go();\ngoing.catch(() => {});\ngo().catch(() => {}); // gone already\n",
			),
			"a comment on its line or one of the two above says why",
		).toEqual([]);
		expect(
			silentCatches(
				"// Gone already.\nconst one = 1;\nconst two = 2;\ngo().catch(() => {});\n",
			),
			"a comment further up says nothing of it",
		).toEqual([4]);
		expect(
			silentCatches(
				"const found = await go().catch(() => undefined);\nreturn go().catch(() => null);\nreading ??= go().catch(() => undefined);\ngo().catch((error) => report(error));\n",
			),
			"one turning the failure into an absence its statement keeps, or handling it, is left alone",
		).toEqual([]);
		expect(
			silentCatches(
				"await go().catch(() => undefined);\nwork.close().catch(() => null);\nif (await go().catch(() => void 0)) stop();\nawait go(() => 1).catch(() => undefined);\n",
			),
			"one giving undefined or null that nothing keeps is found",
		).toEqual([1, 2, 3, 4]);
		expect(
			silentCatches("const found = go().catch(() => {});\n"),
			"an empty body is found even where its value is kept",
		).toEqual([1]);
		expect(
			silentCatches(
				'// Best effort: a failure costs nothing.\nawait this.wires\n\t.cdp()\n\t.send("x")\n\t.catch(() => undefined);\n// It says its own failures.\nawait refuse(\n\ttaken,\n\t`couldn\'t`,\n).catch(() => {});\n',
			),
			"a comment above where a chain or a wrapped call starts says why",
		).toEqual([]);
		expect(
			silentCatches(
				'const ran = work\n\t.exec("true")\n\t.catch(() => undefined);\nconst owner = await find(\n\tplace,\n).catch(() => undefined);\nconst tell = () =>\n\tbegan\n\t\t.then(() => {\n\t\t\tsay();\n\t\t})\n\t\t.catch(() => undefined);\n',
			),
			"a value kept on the line its statement starts is left alone",
		).toEqual([]);
		expect(
			silentCatches(
				"afterAll(async () => {\n\tfor (const each of opened) await each.close().catch(() => undefined);\n});\n",
			),
			"a block's opening line is no start of the statement inside it",
		).toEqual([2]);
		expect(
			silentCatches(
				"/** Start it. */\nconst kick = () => go().catch(() => {});\n/**\n * Kick it.\n */\ngo().catch(() => {});\n",
			),
			"a doc comment says what a thing is, not why its failure can go",
		).toEqual([2, 6]);
	});

	it("are read in every TypeScript and JavaScript file", () => {
		const names = ["a.ts", "b.mts", "c.cts", "d.tsx", "e.js", "f.mjs"];
		expect(
			[...names, "g.cjs", "h.json", "i.md"].filter((file) => SOURCE.test(file)),
		).toEqual([...names, "g.cjs"]);
	});

	it("say why any empty one lets its error go", WALK, () => {
		const silent = packageFiles(ROOT)
			.filter((file) => SOURCE.test(file))
			// This file's own examples drop their errors on purpose.
			.filter((file) => file !== relative(ROOT, import.meta.filename))
			.flatMap((file) =>
				silentCatches(readFileSync(join(ROOT, file), "utf8")).map(
					(line) => `${file}:${line}`,
				),
			);
		expect(
			silent,
			"these catches drop their error and say nothing: say why the failure can go in a comment inside the catch, or for a promise's on its line or one of the two above, or handle it",
		).toEqual([]);
	});
});
