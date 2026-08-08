/**
 * Finding every builder that makes a round.
 *
 * Two gates sweep the same set for two different facts, and they were
 * written as one file copied and one predicate changed, canary list
 * included. A second copy of the discovery is a second thing to
 * update when a builder changes shape, and the whole reason either
 * gate exists is that the last fact needing all of them reached four.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One file that builds rounds, and how many it builds. */
export interface RoundBuilder {
	name: string;
	source: string;
	/** How many rounds this file builds from scratch. */
	built: number;
}

/**
 * Every file under `lib/review/ask` that builds a round.
 *
 * Found by the moment a round stamps on itself, which is what
 * identifies one. Looking for the round's kind as a literal missed the
 * council, which takes it from the opening and writes it shorthand:
 * the scan could not see the one builder that was already right, and
 * the count it was checked against happened to match without it.
 */
export function roundBuilders(): RoundBuilder[] {
	const dir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"..",
		"lib",
		"review",
		"ask",
	);
	const builders: RoundBuilder[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".ts")) continue;
		const source = readFileSync(join(dir, name), "utf8");
		const built = source.split("startedAt: startedAt.toISOString()").length - 1;
		if (built === 0) continue;
		builders.push({ name, source, built });
	}
	return builders;
}

/**
 * The files expected to build rounds, named rather than counted.
 *
 * A count is what let a missing builder look like a full sweep.
 * `collect.ts` is not among them and should not be: it settles a round
 * somebody else formed, spreading what that round already held, so it
 * inherits its provenance rather than choosing any.
 */
export const BUILDERS = [
	"audit.ts",
	"council.ts",
	"critique.ts",
	"judge.ts",
	"stack-round.ts",
];
