/**
 * Refusals that hand the caller the fix: when a target cannot
 * be used, say why and offer targets that would work.
 *
 * Every candidate offered here is verified against the tree
 * before it is returned, so a caller can take one and use it
 * without wondering whether it resolves.
 */

import type { AxNode } from "../a11y/index.js";
import { foldEquals, resolveTarget, type Target } from "./target.js";

/** A target the caller could use instead, and why it is offered. */
export interface TargetCandidate {
	readonly target: Target;
	readonly hint: string;
}

/** Why a target could not be used, and what to try instead. */
export interface TargetRefusal {
	readonly reason: "ambiguous" | "notFound" | "notActionable";
	readonly candidates: readonly TargetCandidate[];
	/**
	 * Near misses that were dropped for being text rather than
	 * controls, described as role and name.
	 *
	 * They are not offered as candidates, since acting on text
	 * spends the caller's next call on something that cannot work.
	 * They are still the answer more often than not: a div dressed
	 * as a button, or a label whose control is named something
	 * else, puts the words on the page under a role nobody can
	 * act on.
	 */
	readonly inert?: readonly string[];
	/** How long act waited for actionability before giving up. */
	readonly waitedMs?: number;
	/** What stood in the way, when the element was not actionable. */
	readonly blocking?: string;
}

/** How many suggestions a refusal offers before it stops. */
const MAX_CANDIDATES = 3;

/** How far a name may be off and still count as a near miss. */
const MAX_EDIT_DISTANCE = 2;

/** A node together with the ancestors that lead to it. */
interface Located {
	readonly node: AxNode;
	readonly ancestors: readonly AxNode[];
}

/** Why a near miss was offered, and how near it was. */
interface NearMiss {
	readonly located: Located;
	/** Lower sorts first: the rung of the ladder that matched. */
	readonly rank: number;
	readonly reason: string;
}

/**
 * Enumerate the elements an ambiguous target matched, each as
 * a target that singles it out.
 */
export function ambiguityRefusal(root: AxNode, target: Target): TargetRefusal {
	const matches = matchesOf(root, target);
	const candidates = matches.map((match, index) =>
		singleOut(root, target, match, index, matches),
	);
	return { reason: "ambiguous", candidates };
}

/** A target for one match, preferring a container over an ordinal. */
function singleOut(
	root: AxNode,
	target: Target,
	match: Located,
	index: number,
	matches: readonly Located[],
): TargetCandidate {
	const container = distinguishingContainer(match, matches);
	if (container) {
		const proposal: Target = {
			role: target.role,
			name: target.name,
			container: { name: container.name },
		};
		if (resolvesTo(root, proposal, match.node)) {
			return {
				target: proposal,
				hint: `in ${container.role} "${container.name}"`,
			};
		}
	}

	const proposal: Target = {
		role: target.role,
		name: target.name,
		...(target.container ? { container: target.container } : {}),
		ordinal: index + 1,
	};
	const nearest = nearestNamed(match);
	const place = `${index + 1} of ${matches.length}`;
	return {
		target: proposal,
		hint: nearest ? `${place}, in ${nearest.role} "${nearest.name}"` : place,
	};
}

/**
 * The closest named ancestor holding this match and no other,
 * which therefore tells it apart from its siblings.
 */
function distinguishingContainer(
	match: Located,
	matches: readonly Located[],
): AxNode | undefined {
	for (const ancestor of [...match.ancestors].reverse()) {
		if (!ancestor.name.trim()) continue;
		const held = matches.filter((other) => other.ancestors.includes(ancestor));
		if (held.length === 1) return ancestor;
	}
	return undefined;
}

/** The closest ancestor with a name, for describing where a match sits. */
function nearestNamed(match: Located): AxNode | undefined {
	return [...match.ancestors]
		.reverse()
		.find((one) => one.name.trim() !== "" && !NON_CONTAINERS.has(one.role));
}

/**
 * Roles that contain everything and therefore locate nothing.
 * "In the page" is true of every element and helps no one.
 */
const NON_CONTAINERS = new Set(["RootWebArea"]);

/** Whether a proposed target lands on exactly the intended node. */
function resolvesTo(root: AxNode, proposal: Target, intended: AxNode): boolean {
	const resolution = resolveTarget(root, proposal);
	return (
		resolution.kind === "resolved" &&
		resolution.backendDomId === intended.backendDomId
	);
}

/** Every node the target matches, in document order. */
function matchesOf(root: AxNode, target: Target): Located[] {
	const container = target.container;
	const scoped = container
		? locate(root).filter((one) => inContainer(one, container))
		: locate(root);
	return scoped.filter(
		(one) =>
			foldEquals(one.node.role, target.role) &&
			foldEquals(one.node.name, target.name),
	);
}

/** Whether a located node sits in (or is) a matching container. */
function inContainer(
	located: Located,
	container: NonNullable<Target["container"]>,
): boolean {
	const matches = (node: AxNode): boolean =>
		foldEquals(node.name, container.name) &&
		(container.role === undefined || foldEquals(node.role, container.role));
	return matches(located.node) || located.ancestors.some(matches);
}

/** Every node under root, each with the ancestors leading to it. */
function locate(root: AxNode): Located[] {
	const found: Located[] = [];
	const walk = (node: AxNode, ancestors: AxNode[]): void => {
		found.push({ node, ancestors });
		for (const child of node.children) walk(child, [...ancestors, node]);
	};
	walk(root, []);
	return found;
}

/**
 * Suggest the nearest elements to a target that matched
 * nothing, climbing a ladder from "same name, written
 * differently" down to "a character or two off", and
 * preferring the role the caller asked for at every rung.
 */
export function notFoundRefusal(root: AxNode, target: Target): TargetRefusal {
	const seen = new Set<string>();
	const candidates: TargetCandidate[] = [];

	const near = locate(root)
		.map((located) => nearMiss(located, target))
		.filter((miss): miss is NearMiss => miss !== undefined)
		.sort((a, b) => a.rank - b.rank);
	const ranked = near.filter((miss) => isActionable(miss.located.node));

	for (const miss of ranked) {
		if (candidates.length === MAX_CANDIDATES) break;
		const { role, name } = miss.located.node;
		const key = `${role}\u0000${name}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const proposal = firstResolvable(root, role, name);
		if (!proposal) continue;
		candidates.push({ target: proposal, hint: hintFor(miss, target) });
	}

	// Only worth saying when there is nothing better to offer. A
	// caller handed three usable targets does not need to hear
	// about the text as well.
	const inert =
		candidates.length > 0
			? []
			: [
					...new Set(
						near
							.filter((miss) => !isActionable(miss.located.node))
							.map(
								(miss) =>
									`${miss.located.node.role} "${miss.located.node.name}"`,
							),
					),
				].slice(0, MAX_CANDIDATES);

	return {
		reason: "notFound",
		candidates,
		...(inert.length === 0 ? {} : { inert }),
	};
}

/**
 * Roles that carry text but cannot be operated. Offering one
 * as a candidate spends the caller's next call on something
 * that was never going to work.
 */
const INERT_ROLES = new Set([
	"StaticText",
	"InlineTextBox",
	"text",
	"LabelText",
	"ListMarker",
	"RootWebArea",
]);

/** Whether a node is something a caller could actually act on. */
function isActionable(node: AxNode): boolean {
	return !INERT_ROLES.has(node.role);
}

/** How near this node is to what was asked for, if at all. */
function nearMiss(located: Located, target: Target): NearMiss | undefined {
	const { role, name } = located.node;
	if (!name.trim()) return undefined;

	const sameRole = foldEquals(role, target.role);

	// Asking for a control with no name says nothing about names,
	// so there is no ladder to climb: what is worth offering is
	// the controls that share the role and do have a name, which
	// is how the caller will end up addressing one. Running the
	// ladder anyway made a near miss of every named node on the
	// page, since every name contains the empty string.
	if (target.name === undefined || target.name === "") {
		return sameRole
			? { located, rank: 0, reason: "same role, and it has a name" }
			: undefined;
	}

	const rung = nameRung(name, target.name);
	if (rung === undefined) return undefined;

	// Every rung prefers the asked-for role to the same name elsewhere.
	return {
		located,
		rank: rung.step * 2 + (sameRole ? 0 : 1),
		reason: rung.reason,
	};
}

/** Which rung of the name ladder this name reaches, if any. */
function nameRung(
	found: string,
	asked: string | undefined,
): { step: number; reason: string } | undefined {
	if (asked === undefined) return undefined;
	if (found === asked) return { step: 0, reason: "same name" };
	if (foldEquals(found, asked)) {
		return { step: 0, reason: "same name, written differently" };
	}

	const haystack = found.trim().toLowerCase();
	const needle = asked.trim().toLowerCase();
	if (haystack.includes(needle)) {
		return { step: 1, reason: "name contains what you asked for" };
	}
	if (needle.includes(haystack)) {
		return { step: 1, reason: "name is part of what you asked for" };
	}

	if (editDistance(haystack, needle) <= MAX_EDIT_DISTANCE) {
		return { step: 2, reason: "a character or two different" };
	}
	return undefined;
}

/** Say why a suggestion is being offered, and where it sits. */
function hintFor(miss: NearMiss, target: Target): string {
	const parts: string[] = [];
	if (!foldEquals(miss.located.node.role, target.role)) {
		parts.push(`${miss.located.node.role} instead of ${target.role}`);
	}
	parts.push(miss.reason);
	const container = nearestNamed(miss.located);
	if (container) parts.push(`in ${container.role} "${container.name}"`);
	return parts.join(", ");
}

/** A target for this role and name that lands on exactly one node. */
function firstResolvable(
	root: AxNode,
	role: string,
	name: string,
): Target | undefined {
	const plain: Target = { role, name };
	if (resolveTarget(root, plain).kind === "resolved") return plain;
	const first: Target = { role, name, ordinal: 1 };
	return resolveTarget(root, first).kind === "resolved" ? first : undefined;
}

/** Levenshtein distance between two strings. */
function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const substitute = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
			current[j] = Math.min(substitute, previous[j] + 1, current[j - 1] + 1);
		}
		previous = current;
	}
	return previous[b.length];
}

/** Put a refusal into words, the same way for every tool. */
export function describeRefusal(
	target: Target,
	refusal: TargetRefusal,
): string {
	const asked = describeTarget(target);
	const lines: string[] = [headline(asked, refusal)];
	for (const candidate of refusal.candidates) {
		lines.push(`  ${describeTarget(candidate.target)} (${candidate.hint})`);
	}
	return lines.join("\n");
}

/** The opening line: what happened to the target that was asked for. */
function headline(asked: string, refusal: TargetRefusal): string {
	if (refusal.reason === "ambiguous") {
		return (
			`${refusal.candidates.length} elements match ${asked}. ` +
			`Use one of these instead:`
		);
	}
	if (refusal.reason === "notActionable") {
		const waited =
			refusal.waitedMs === undefined
				? ""
				: ` after waiting ${refusal.waitedMs}ms`;
		const blocking = refusal.blocking ? `: ${refusal.blocking}` : "";
		return `${asked} did not become actionable${waited}${blocking}.`;
	}
	if (refusal.candidates.length > 0)
		return `Nothing matches ${asked}. Did you mean:`;
	if (refusal.inert && refusal.inert.length > 0) {
		// The words are on the page under a role nobody can act on,
		// which is a different problem from a mistyped name and
		// wants a different next move.
		return (
			`Nothing matches ${asked}. The page carries that name as ` +
			`${refusal.inert.join(", ")}, which is text rather than ` +
			"something to act on, so the element may be missing the " +
			"role you expected."
		);
	}
	return `Nothing matches ${asked}, and nothing on the page is close to it.`;
}

/**
 * A target written the way a caller would pass it back.
 *
 * A control with no accessible name is addressed by its role
 * alone, so that is how it is written here. Printing an empty
 * name would be telling the caller to pass punctuation back,
 * and the outline it was read from does not show one either.
 */
export function describeTarget(target: Target): string {
	const parts = [
		target.name
			? `role ${target.role} name "${target.name}"`
			: `role ${target.role}`,
	];
	if (target.container) parts.push(`container "${target.container.name}"`);
	if (target.ordinal !== undefined) parts.push(`ordinal ${target.ordinal}`);
	return parts.join(" ");
}
