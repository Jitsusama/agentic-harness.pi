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
 * Only a statement's catch is read, `} catch {` or `} catch (error) {`
 * at the start of a line as biome lays it out, so a catch written inside
 * a string is no catch. A body holding code handles its error in some
 * way and is left alone.
 *
 * A promise's `.catch(() => {})` drops its error the same way, and says
 * why in a comment on its line or one of the two above: the promise is
 * often made on the line before its catch, with the reason above that.
 * A `.catch(() => undefined)` is not read: it turns the failure into an
 * absence its caller handles.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { packageFiles } from "./package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The endings of the TypeScript files read. */
const TYPESCRIPT = /\.(?:ts|mts|cts|tsx)$/;

/** A statement's empty catch, as biome lays it out: nothing but space in its block. */
const EMPTY_CATCH =
	/^[ \t]*\}?[ \t]*catch\b[ \t]*(?:\([^)]*\))?[ \t]*\{\s*\}/gm;

/** A promise's catch that drops its error, written on one line as biome lays it out. */
const PROMISE_DROP =
	/\.catch\(\s*(?:async\s*)?\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/;

/** How long a read of every file may take on a busy machine. */
const WALK = { timeout: 60_000 };

/** The lines, counted from 1, of each catch in some source that is empty and says nothing. */
function silentCatches(text: string): number[] {
	const lines = text.split("\n");
	const dropped = lines.flatMap((line, at) =>
		PROMISE_DROP.test(line) &&
		![line, lines[at - 1], lines[at - 2]].some((near) => says(near ?? ""))
			? [at + 1]
			: [],
	);
	const empty = [...text.matchAll(EMPTY_CATCH)].map(
		(found) => text.slice(0, found.index).split("\n").length,
	);
	return [...empty, ...dropped].sort((a, b) => a - b);
}

/** Whether a line is a comment, or ends with one. */
function says(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("*") ||
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
			"a catch inside a string is no catch",
		).toEqual([]);
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
				"const found = await go().catch(() => undefined);\ngo().catch((error) => report(error));\n",
			),
			"one turning the failure into an absence, or handling it, is left alone",
		).toEqual([]);
	});

	it("say why any empty one lets its error go", WALK, () => {
		const silent = packageFiles(ROOT)
			.filter((file) => TYPESCRIPT.test(file))
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
