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
 * way and is left alone; a promise's `.catch(() => {})` is not read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageFiles } from "./package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The endings of the TypeScript files read. */
const TYPESCRIPT = /\.(?:ts|mts|cts|tsx)$/;

/** A statement's empty catch, as biome lays it out: nothing but space in its block. */
const EMPTY_CATCH =
	/^[ \t]*\}?[ \t]*catch\b[ \t]*(?:\([^)]*\))?[ \t]*\{\s*\}/gm;

/** How long a read of every file may take on a busy machine. */
const WALK = { timeout: 60_000 };

/** The lines, counted from 1, of each catch in some source that is empty and says nothing. */
function silentCatches(text: string): number[] {
	return [...text.matchAll(EMPTY_CATCH)].map(
		(found) => text.slice(0, found.index).split("\n").length,
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
	});

	it("say why any empty one lets its error go", WALK, () => {
		const silent = packageFiles(ROOT)
			.filter((file) => TYPESCRIPT.test(file))
			.flatMap((file) =>
				silentCatches(readFileSync(join(ROOT, file), "utf8")).map(
					(line) => `${file}:${line}`,
				),
			);
		expect(
			silent,
			"these catches drop their error and say nothing: say in a comment inside why the failure can go, or handle it",
		).toEqual([]);
	});
});
