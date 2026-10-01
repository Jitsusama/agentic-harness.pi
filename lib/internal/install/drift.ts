/**
 * Whether a package's installed dependencies are the ones its
 * `package.json` asks for.
 *
 * A checkout that is pulled is not reinstalled, so its code can ask for
 * a dependency's new export while `node_modules` still holds the old
 * version. Nothing fails at load: the import reads `undefined`, and the
 * first call to it throws somewhere far from the cause. Comparing each
 * installed version with its range at start names the cause instead.
 *
 * Only the range shapes this package writes are read: caret, tilde,
 * exact, `>=` and `*`, over full `major.minor.patch` versions. Anything
 * else (a git or file spec, a partial version, a prerelease) is
 * reported as unchecked rather than guessed at, since a wrong verdict
 * here would tell somebody to reinstall for nothing.
 */

/** A version as three numbers. */
type Triple = readonly [number, number, number];

/** How one dependency stands against its range. */
export type DependencyVerdict =
	| "satisfied"
	| "outside"
	| "missing"
	| "unchecked";

/** One dependency, its range, what is installed and the verdict. */
export interface DependencyStanding {
	readonly name: string;
	readonly range: string;
	readonly installed?: string;
	readonly verdict: DependencyVerdict;
}

const TRIPLE = /^(\d+)\.(\d+)\.(\d+)$/;

function triple(version: string): Triple | undefined {
	const match = TRIPLE.exec(version.trim());
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: Triple, b: Triple): number {
	for (let at = 0; at < 3; at++) {
		const difference = (a[at] ?? 0) - (b[at] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The exclusive upper bound a caret range allows. */
function caretCeiling([major, minor, patch]: Triple): Triple {
	if (major > 0) return [major + 1, 0, 0];
	if (minor > 0) return [0, minor + 1, 0];
	return [0, 0, patch + 1];
}

/**
 * Whether a version satisfies a range, or `undefined` when either is a
 * shape this does not read.
 */
export function satisfies(version: string, range: string): boolean | undefined {
	const installed = triple(version);
	if (!installed) return undefined;
	const wanted = range.trim();
	if (wanted === "*" || wanted === "") return true;
	const operator = /^(\^|~|>=)?(.*)$/.exec(wanted);
	const floor = triple(operator?.[2] ?? "");
	if (!floor) return undefined;
	const atLeast = compare(installed, floor) >= 0;
	switch (operator?.[1]) {
		case "^":
			return atLeast && compare(installed, caretCeiling(floor)) < 0;
		case "~":
			return atLeast && compare(installed, [floor[0], floor[1] + 1, 0]) < 0;
		case ">=":
			return atLeast;
		default:
			return compare(installed, floor) === 0;
	}
}

/**
 * Each dependency's standing, given the ranges and a way to read what is
 * installed.
 */
export function dependencyStandings(
	ranges: Readonly<Record<string, string>>,
	installedOf: (name: string) => string | undefined,
): DependencyStanding[] {
	return Object.entries(ranges).map(([name, range]) => {
		const installed = installedOf(name);
		if (installed === undefined) return { name, range, verdict: "missing" };
		const verdict = satisfies(installed, range);
		return {
			name,
			range,
			installed,
			verdict:
				verdict === undefined ? "unchecked" : verdict ? "satisfied" : "outside",
		};
	});
}

/** The standings that mean the install is not what the code expects. */
export function drifted(
	standings: readonly DependencyStanding[],
): DependencyStanding[] {
	return standings.filter(
		(s) => s.verdict === "outside" || s.verdict === "missing",
	);
}

/** One line naming each drifted dependency and what it wants. */
export function describeDrift(
	standings: readonly DependencyStanding[],
): string {
	return standings
		.map((s) =>
			s.verdict === "missing"
				? `${s.name} is not installed (wants ${s.range})`
				: `${s.name} ${s.installed} (wants ${s.range})`,
		)
		.join("; ");
}
