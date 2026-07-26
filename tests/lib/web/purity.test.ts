/**
 * The analysis barrels must stay pure.
 *
 * Every subdomain but the session is meant to be capture
 * agnostic: serializable data in, answers out, so the same code
 * judges a live page, a stored capture, or one taken by
 * something that is not this library. That promise is only worth
 * anything if importing an analysis module does not start a
 * browser or load a decoder.
 *
 * It has been broken twice by accident, both times invisibly:
 * once by a disk sink that imported the page reader and dragged
 * in jsdom, and once by a compare barrel that re-exported its
 * PNG half. Neither showed up in a type error or a failing test,
 * which is why this is checked rather than merely intended.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

/** Dependencies that cost real time or memory to load. */
const HEAVY = [
	"puppeteer-core",
	"jsdom",
	"defuddle",
	"pixelmatch",
	"pngjs",
	"axe-core",
];

/** Every subdomain that promises to be pure. */
const ANALYSIS = [
	"a11y",
	"audit",
	"compare",
	"design",
	"element",
	"envelope",
	"environment",
	"evaluate",
	"input",
	"perf",
	"snapshot",
	"sourcemap",
	"styles",
	"target",
	"telemetry",
	"wait",
];

/** Follow the static imports from a file and report heavy hits. */
function heavyReachableFrom(
	entry: string,
	seen = new Set<string>(),
	chain: readonly string[] = [],
): string[] {
	if (seen.has(entry)) return [];
	seen.add(entry);

	const source = readFileSync(entry, "utf8");
	const specifiers = [
		...source.matchAll(/^\s*(?:import|export)[^'"]*?from\s+["']([^"']+)["']/gm),
	].map((found) => found[1] ?? "");

	const hits: string[] = [];
	for (const specifier of specifiers) {
		if (!specifier.startsWith(".")) {
			if (HEAVY.includes(specifier)) {
				hits.push(
					[...chain, entry, specifier]
						.map((step) => step.replace(`${ROOT}/`, ""))
						.join(" -> "),
				);
			}
			continue;
		}
		let next = path.resolve(
			path.dirname(entry),
			specifier.replace(/\.js$/, ".ts"),
		);
		if (!existsSync(next)) next = next.replace(/\.ts$/, "/index.ts");
		if (!existsSync(next)) continue;
		hits.push(...heavyReachableFrom(next, seen, [...chain, entry]));
	}
	return hits;
}

describe("lib/web analysis barrels", () => {
	it.each(ANALYSIS)("%s reaches no heavy dependency", (name) => {
		const barrel = path.join(ROOT, "lib/web", name, "index.ts");
		expect(existsSync(barrel)).toBe(true);
		expect(heavyReachableFrom(barrel)).toEqual([]);
	});

	it("can actually detect an impure import", () => {
		// Without this the suite above would pass just as happily if
		// the walker silently found nothing at all.
		const session = path.join(ROOT, "lib/web/session.ts");
		expect(heavyReachableFrom(session).length).toBeGreaterThan(0);
	});
});
