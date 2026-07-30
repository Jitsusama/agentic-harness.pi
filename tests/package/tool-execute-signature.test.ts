/**
 * A tool's execute must take the call id before the arguments.
 *
 * Pi's contract is `execute(toolCallId, params, signal, onUpdate, ctx)`. A
 * body that declares one parameter therefore binds the **id** to it, and
 * the id is a string, so every field read off it is `undefined` and every
 * optional parameter silently falls to its default.
 *
 * That is not a hypothetical. It shipped in two tools at once. `review_ask`
 * answered the run listing whatever action it was asked for, which meant a
 * council could never run: the roster, the personas, the judge and the
 * fan-out were all reachable only through an action that never arrived.
 * `work` answered the tree listing the same way, so no tree could be cut.
 * Both looked like features nobody had finished rather than a dropped
 * argument, and both were found by driving the tools rather than by reading
 * them.
 *
 * TypeScript cannot catch it. A function is assignable to a signature with
 * more parameters than it declares, which is the rule that makes
 * `arr.map((x) => x)` legal, and `unknown` accepts the string quite
 * happily. So the check has to be on the source text.
 *
 * The rule is about `pi.registerTool` only. A tool handed to a model call
 * takes `(args)` by that API's own convention, which is why the advisor's
 * investigation tools are not a violation and are not scanned: they never
 * reach `registerTool`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSIONS = join(import.meta.dirname, "..", "..", "extensions");

/** Names that say the first parameter is the call id rather than the payload. */
const CALL_ID = new Set([
	"_toolCallId",
	"toolCallId",
	"_id",
	"id",
	"_callId",
	"callId",
]);

/** Every `.ts` file under a directory, walked. */
function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourceFiles(path));
			continue;
		}
		if (entry.endsWith(".ts")) found.push(path);
	}
	return found;
}

/**
 * The first parameter of each execute in a file that registers a tool.
 *
 * Both spellings have to be read, because the two that shipped broken used
 * one each: a method shorthand and an arrow property.
 */
function executeSignatures(
	source: string,
): Array<{ line: number; first: string }> {
	const found: Array<{ line: number; first: string }> = [];
	const lines = source.split("\n");
	lines.forEach((text, index) => {
		const match =
			/(?:async\s+execute\s*\(|execute\s*:\s*async\s*\()\s*(.*)$/.exec(text);
		if (!match) return;
		// A multi-line signature puts the first parameter on the next line.
		const head = match[1].trim();
		const rest = head === "" ? (lines[index + 1] ?? "").trim() : head;
		const first = rest.split(",")[0].split(")")[0].split(":")[0].trim();
		found.push({ line: index + 1, first });
	});
	return found;
}

describe("every registered tool reads its arguments from the second parameter", () => {
	const offenders: string[] = [];
	const checked: string[] = [];

	for (const file of sourceFiles(EXTENSIONS)) {
		const source = readFileSync(file, "utf8");
		if (!source.includes("registerTool")) continue;
		for (const { line, first } of executeSignatures(source)) {
			const where = `${file.slice(EXTENSIONS.length + 1)}:${line}`;
			checked.push(where);
			if (!CALL_ID.has(first))
				offenders.push(`${where} takes (${first}) first`);
		}
	}

	it("finds executes to check, rather than passing on an empty sweep", () => {
		// A walker that matched nothing would report no offenders and mean
		// nothing at all, which is the failure this whole file exists to
		// stop happening in a different place.
		expect(checked.length).toBeGreaterThan(5);
	});

	it("names the call id before the arguments everywhere", () => {
		expect(
			offenders,
			`Pi calls execute(toolCallId, params, ...). These bind the id to their first parameter, so params is a string and every argument reads as undefined:\n  ${offenders.join("\n  ")}`,
		).toEqual([]);
	});
});
