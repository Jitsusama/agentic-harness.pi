import type { RoleModel, RoleModelCost } from "./model.ts";

/**
 * A model whose entire catalogue entry is redundant: some other model
 * in the same family, from the same provider namespace, is newer and
 * costs no more on any rate. Keeping it around is a name somebody
 * could still type, not a genuine choice.
 */
export interface ArchaicFinding {
	readonly id: string;
	readonly provider: string;
	readonly supersededBy: string;
}

/** An eight-digit segment reads as a pinned snapshot date, not a version step. */
const PINNED_SNAPSHOT = /^\d{8}$/;
const NUMERIC = /^\d+$/;

interface Parsed {
	readonly family: string;
	readonly version: number[];
}

/**
 * Split a model id into the family it belongs to and the version
 * within that family: every non-numeric hyphen-separated segment joins
 * the family name, every numeric one becomes a version component,
 * except an eight-digit segment, which is a pinned snapshot date and
 * carries no version information at all.
 */
function parse(id: string): Parsed {
	const family: string[] = [];
	const version: number[] = [];
	for (const part of id.split("-")) {
		if (PINNED_SNAPSHOT.test(part)) continue;
		if (NUMERIC.test(part)) {
			version.push(Number.parseInt(part, 10));
		} else {
			family.push(part);
		}
	}
	return { family: family.join("-"), version };
}

/**
 * Compare two version tuples the way a shared-prefix naming scheme
 * means them to be compared: element by element, and when one runs out
 * first while every shared element matched, the longer one is newer
 * (`opus-5` precedes `opus-5-5`).
 */
function compareVersions(a: readonly number[], b: readonly number[]): number {
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const diff = (a[i] ?? -1) - (b[i] ?? -1);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** True when every rate on `a` is no more expensive than the matching rate on `b`. */
function noCostlierOnAnyAxis(a: RoleModelCost, b: RoleModelCost): boolean {
	return (
		a.input <= b.input &&
		a.output <= b.output &&
		a.cacheRead <= b.cacheRead &&
		a.cacheWrite <= b.cacheWrite
	);
}

/**
 * Which models are archaic: for each one, does a same-family,
 * same-provider-namespace sibling exist that is strictly newer and no
 * costlier on any rate. When several such siblings exist, the finding
 * names the cheapest of them by cache read, since that is the one
 * there is actually the least reason to still reach for the older one
 * over.
 */
export function findArchaic(models: readonly RoleModel[]): ArchaicFinding[] {
	const findings: ArchaicFinding[] = [];

	for (const candidate of models) {
		const candidateVersion = parse(candidate.id);
		let bestSibling: RoleModel | undefined;

		for (const sibling of models) {
			if (sibling.id === candidate.id) continue;
			if (sibling.provider !== candidate.provider) continue;
			const siblingVersion = parse(sibling.id);
			if (siblingVersion.family !== candidateVersion.family) continue;
			if (
				compareVersions(siblingVersion.version, candidateVersion.version) <= 0
			) {
				continue;
			}
			if (!noCostlierOnAnyAxis(sibling.cost, candidate.cost)) continue;
			if (!bestSibling || sibling.cost.cacheRead < bestSibling.cost.cacheRead) {
				bestSibling = sibling;
			}
		}

		if (bestSibling) {
			findings.push({
				id: candidate.id,
				provider: candidate.provider,
				supersededBy: bestSibling.id,
			});
		}
	}

	return findings;
}
