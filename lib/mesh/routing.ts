/**
 * Routing: the groups a message goes to when its sender named none.
 *
 * The sender chooses who hears (see attention.ts for what the receiver
 * chooses), and most of the time it names the group. When it does not,
 * the mesh chooses for it rather than refusing, since a refused message
 * is one nobody hears and a sender told to try again often gives up.
 * It goes, in turn, by:
 *
 * - references: the groups the text names (`stick`, `core.nix`), and
 *   the home of each peer it names by address or by what it owns that
 *   those groups do not reach;
 * - the classifier, choosing among the groups other peers are in, or
 *   the whole machine, trusted only when it is sure;
 * - a rule: a hold goes to the whole machine, since what it holds is
 *   usually heavy work any peer may start; anything else to the
 *   sender's own scopes that another peer is in, where peers on its
 *   work hear it; failing those, to the nearest quest above its own
 *   that another peer hears, since a subquest alone on its scope is
 *   still its parent's work; and to the whole machine when none is,
 *   since a message nobody hears is the one outcome worse than a
 *   glance.
 *
 * The sender is told where it went and why, so it can say otherwise.
 * A peer that stopped the sender is never routed to.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import { mentions } from "./attention.ts";
import { ALL, hears, homeOf } from "./group.ts";
import type { Intent } from "./message.ts";
import type { Presence } from "./presence.ts";
import { stoppedBy } from "./stop.ts";

/** Where a message goes, and why, for the sender to read. */
export interface Route {
	readonly to: readonly string[];
	readonly why: string;
}

/** A group other peers are in, which a message could be routed to. */
export interface Candidate {
	readonly group: string;
	readonly members: readonly Presence[];
}

/** The sender, as routing needs it. */
export interface Sender {
	readonly session: string;
	readonly scopes: readonly string[];
	readonly addresses: readonly string[];
}

/**
 * Below this, the classifier's pick of a group is not trusted: asked
 * live about thirteen messages, the five groups it picked at this or
 * more were all right, while it sent a stick's qemu finding to the
 * harness at an even chance and "going to lunch" there at two in three.
 */
export const ROUTE_AT_LEAST = 0.8;

/**
 * The whole machine costs every peer a line, so the classifier's pick
 * of it is held higher: asked live, it sent two reboots there at 97
 * and 100, but also "going to lunch" at 92 and a question about the
 * old mailbox at 77.
 */
export const ALL_AT_LEAST = 0.95;

/**
 * The named groups other peers still there are in, narrowest first:
 * neither homes nor the machine, which routing reaches another way.
 */
export function candidatesOf(
	everyone: readonly Presence[],
	sender: Pick<Sender, "session">,
): Candidate[] {
	const byGroup = new Map<string, Presence[]>();
	for (const one of everyone) {
		if (one.session === sender.session) continue;
		for (const group of one.groups) {
			if (!group.startsWith("#") || group === ALL) continue;
			byGroup.set(group, [...(byGroup.get(group) ?? []), one]);
		}
	}
	return [...byGroup.entries()]
		.map(([group, members]) => ({ group, members }))
		.sort(
			(a, b) =>
				a.members.length - b.members.length || a.group.localeCompare(b.group),
		);
}

/**
 * Where the text's references send it: the groups it names, and the home
 * of every peer it names that those do not reach. Nothing when it names
 * neither.
 */
export function routeByReferences(
	text: string,
	sender: Pick<Sender, "session">,
	everyone: readonly Presence[],
	candidates: readonly Candidate[] = candidatesOf(everyone, sender),
): Route | undefined {
	const words = `-${wordsOf(text)}-`;
	const matched = candidates
		.map(({ group }) => group)
		.filter((group) => {
			const tail = wordsOf(group.split("/").pop() ?? "");
			return tail.length >= 4 && words.includes(`-${tail}-`);
		});
	// A group a broader match already reaches adds nobody.
	const groups = matched.filter(
		(group) =>
			!matched.some((other) => other !== group && hears([group], other)),
	);
	const named = everyone.filter(
		(one) =>
			one.session !== sender.session &&
			one.addresses.length > 0 &&
			mentions({ text }, one),
	);
	const unreached = named.filter(
		(one) => !groups.some((group) => hears(one.groups, group)),
	);
	const to = [
		...groups,
		...unreached.map((one) => homeOf(one.addresses[0] as string)),
	];
	if (to.length === 0) return undefined;
	const said = [
		groups.length > 0 ? `it names ${groups.join(", ")}` : "",
		unreached.length > 0
			? `it names ${unreached.map((one) => one.addresses[0]).join(", ")} or what ${unreached.length === 1 ? "it owns" : "they own"}`
			: "",
	].filter(Boolean);
	return { to, why: said.join(", and ") };
}

/** Text as lowercase words joined by dashes, as group names are. */
function wordsOf(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** What the classifier is asked: which group, keyed as it can answer. */
export function routeQuestion(
	message: { intent: Intent; text: string },
	sender: Pick<Sender, "addresses">,
	candidates: readonly Candidate[],
): { context: ClassifierContext; keys: Map<string, string> } {
	const keys = new Map<string, string>(
		candidates.map(({ group }, index) => [`g${index + 1}`, group]),
	);
	keys.set("all", ALL);
	const described = (group: string) =>
		group === ALL
			? "every session on the machine: only for a reboot, a switch, network or disk trouble, or a hold on heavy work"
			: `${group}: ${(
					candidates.find((one) => one.group === group)?.members ?? []
				)
					.map((one) => `${one.addresses[0]} (${one.worksOn.slice(0, 120)})`)
					.join(", ")}`;
	const criteria = Object.fromEntries(
		[...keys].map(([key, group]) => [
			key,
			`the message is about the work of ${described(group)}`,
		]),
	);
	return {
		keys,
		context: {
			state: {
				sender: { name: sender.addresses[0] ?? "" },
				message: { intent: message.intent, text: message.text },
			},
			questions: {
				to: {
					type: "choice",
					instructions:
						"Which group should this message go to, so it reaches the sessions whose work it is about and as few others as can be?",
					criteria,
				},
			},
		},
	};
}

/** The classifier's pick as a route, or nothing when it was not sure. */
export function routeFrom(
	answer: unknown,
	keys: ReadonlyMap<string, string>,
): Route | undefined {
	const to = answer as {
		type?: unknown;
		choice?: unknown;
		probabilities?: Record<string, number>;
	} | null;
	if (to?.type !== "choice" || typeof to.choice !== "string") return undefined;
	const group = keys.get(to.choice);
	const sure = to.probabilities?.[to.choice] ?? 0;
	if (group === undefined) return undefined;
	if (sure < (group === ALL ? ALL_AT_LEAST : ROUTE_AT_LEAST)) return undefined;
	return {
		to: [group],
		why:
			group === ALL
				? "it was judged to touch the whole machine"
				: `it was judged to be about the work there`,
	};
}

/**
 * Asks the classifier a routing question and hands back its answer to
 * it, or nothing when there is no classifier or it could not answer.
 */
export type Judge = (context: ClassifierContext) => Promise<unknown>;

/**
 * Where a message its sender named no group for goes: by its
 * references, else by the classifier when it is sure, else by rule.
 * Peers that stopped the sender, and ended ones, are left out by the
 * caller passing only those still there.
 */
export async function routeOf(
	message: { intent: Intent; text: string },
	sender: Sender,
	present: readonly Presence[],
	judge?: Judge,
): Promise<Route> {
	const everyone = routable(present, sender);
	const candidates = candidatesOf(everyone, sender);
	const referenced = routeByReferences(
		message.text,
		sender,
		everyone,
		candidates,
	);
	if (referenced) return referenced;
	if (judge && candidates.length > 0) {
		const { context, keys } = routeQuestion(message, sender, candidates);
		try {
			const judged = routeFrom(await judge(context), keys);
			if (judged) return judged;
		} catch {
			// An unjudged message goes by rule.
		}
	}
	return routeByRule(message.intent, sender, everyone);
}

/** Where a message goes when nothing else said. */
export function routeByRule(
	intent: Intent,
	sender: Sender,
	everyone: readonly Presence[],
): Route {
	if (intent === "hold") {
		return {
			to: [ALL],
			why: "a hold that names nowhere holds the whole machine",
		};
	}
	const shared = sender.scopes.filter((scope) =>
		everyone.some(
			(one) => one.session !== sender.session && hears(one.groups, scope),
		),
	);
	if (shared.length > 0) {
		return {
			to: shared,
			why: "it named nowhere, so it goes where other peers on this peer's work hear",
		};
	}
	const above = [
		...new Set(
			sender.scopes.flatMap((scope) => {
				const nearest = scopesAbove(scope).find((one) =>
					everyone.some(
						(other) =>
							other.session !== sender.session && hears(other.groups, one),
					),
				);
				return nearest ? [nearest] : [];
			}),
		),
	];
	if (above.length > 0) {
		return {
			to: above,
			why: "it named nowhere and no other peer is on this peer's own quest, so it goes to the nearest quest above it that another peer hears",
		};
	}
	return {
		to: [ALL],
		why: "it named nowhere and no other peer is on this peer's work, so the whole machine hears it, at the attention each gives it",
	};
}

/**
 * The quest groups above a scope, nearest first: #quest/a/b/c has
 * #quest/a/b and then #quest/a. Only a quest's scope has any, since a
 * repository's group names no parent.
 */
export function scopesAbove(scope: string): string[] {
	if (!scope.startsWith("#quest/")) return [];
	const parts = scope.split("/");
	const above: string[] = [];
	for (let end = parts.length - 1; end >= 2; end -= 1) {
		above.push(parts.slice(0, end).join("/"));
	}
	return above;
}

/** Everyone but the peers that stopped the sender, who are not routed to. */
export function routable(
	everyone: readonly Presence[],
	sender: Pick<Sender, "session" | "addresses">,
): Presence[] {
	const stoppers = new Set(
		stoppedBy(sender, everyone).map(({ stopper }) => stopper.session),
	);
	return everyone.filter((one) => !stoppers.has(one.session));
}
