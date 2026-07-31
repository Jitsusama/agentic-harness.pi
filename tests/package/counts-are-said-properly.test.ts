/**
 * `1 tree(s)` is not a thing a person says.
 *
 * The shortcut is correct for every number and natural for none, and the single-item
 * case is the common one, so the tell shows constantly. One surface here had a private
 * pluralizer for years while the other two spelled `(s)` inline in fifty places, which
 * meant a session could print `1 branch` from one tool and `1 tree(s)` from the next.
 *
 * `lib/ui/count.ts` is the shared answer. This keeps the shortcut from creeping back,
 * because it is always the easier thing to type.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * `thing(s)` in prose, and not a call.
 *
 * `push(s)` puts those three characters next to an identifier too, so the shortcut is
 * recognized by what follows it: prose runs on into a space, a colon, a full stop or
 * an interpolation, where an argument list closes with `;`, `)` or `,`.
 */
const SHORTCUT = /[a-z]\(s\)(?=[\s:.$\\"'`]|$)/;

/** The file that explains the anti-pattern has to be able to write it. */
const EXPLAINS_ITSELF = join("lib", "ui", "count.ts");

function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourcesUnder(path));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) found.push(path);
	}
	return found;
}

describe("a count and its noun", () => {
	it("is never written with the (s) shortcut", () => {
		const offenders = [
			...sourcesUnder(join(ROOT, "lib")),
			...sourcesUnder(join(ROOT, "extensions")),
		]
			.flatMap((path) => {
				const lines = readFileSync(path, "utf8").split("\n");
				return (
					lines
						.map((line, index) => ({ line, at: `${path}:${index + 1}` }))
						.filter(({ line }) => SHORTCUT.test(line))
						// An arrow function parameter named s is not a plural.
						.filter(({ line }) => !line.includes("(s) =>"))
						// The file that explains the anti-pattern has to write it.
						.filter(() => !path.endsWith(EXPLAINS_ITSELF))
						.map(({ line, at }) => `${at}: ${line.trim()}`)
				);
			})
			.map((hit) => hit.replace(ROOT, ""));

		expect(offenders).toEqual([]);
	});
});
