/**
 * `review_offer merge`: landing a change behind its head guard and the
 * repo's own gate, saying enqueued apart from merged, and letting go of
 * a change once it has landed.
 *
 * Apart from `offer.ts` because merging changes with the guards a merge
 * must pass and what landing means for the session, which no other
 * action shares.
 */

import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BoundTarget } from "../../../lib/core/review/index.ts";
import { loadPackageConfig } from "../../../lib/internal/config/loader.ts";
import { sayDid } from "../../../lib/internal/session/events.ts";
import { sayLanded } from "../../../lib/internal/session/landings.ts";
import { REVIEW_SLUG } from "../config.ts";
import { attachments } from "../engine.ts";
import { gateFor, gateRefusal, type RunGate } from "../merge-gate.ts";
import { noteQueued } from "../queued.ts";
import { GLYPH } from "../render.ts";
import { confirmWrite } from "./offer-gates.ts";
import type { OfferParams } from "./offer-request.ts";
import {
	type Answer,
	declined,
	type hostedChange,
	refuse,
	say,
} from "./shared.ts";

/** The shortest prefix of a head taken as an expectation, as git abbreviates. */
const SHORTEST_HEAD_PREFIX = 7;

/**
 * The head to hand the backend as the merge guard, or why this merge
 * should not happen.
 *
 * A refusal says both heads, because the useful fact is which one the
 * change is at and that is what the backend's own refusal leaves out. A
 * prefix is accepted, so the short form a commit prints is a valid
 * expectation rather than a guaranteed mismatch, but it has to be a prefix
 * of the real head and not merely look like one, and the full head it
 * matched is what travels on.
 *
 * The head is undefined when nothing was expected, and the expectation as
 * given when the provider does not report where the head is, in which case
 * the guard still travels to the backend and this adds nothing.
 */
async function headGuard(
	bound: BoundTarget,
	label: string,
	expected: string | undefined,
): Promise<{ refusal: string } | { head: string | undefined }> {
	if (!expected) return { head: undefined };
	if (expected.length < SHORTEST_HEAD_PREFIX) {
		return {
			refusal: `expectedHead ${expected} is too short to guard anything: give at least ${SHORTEST_HEAD_PREFIX} characters of the head, or all of it.`,
		};
	}
	const at = (await bound.proposal())?.headCommit;
	// A prefix is how people read a commit, so one that matches is taken,
	// and the head it matched is what goes to the backend: GitHub refuses
	// anything but the whole sha, and 23 merges failed on that alone.
	if (!at) return { head: expected };
	if (at === expected || at.startsWith(expected)) return { head: at };
	return {
		refusal: [
			`${label} is at ${at}, not ${expected}, so it was not merged.`,
			"That is the head guard doing its job, and it does not mean somebody pushed:",
			"an expectation typed from memory or completed from a short prefix fails the",
			"same way. Read the head, then merge with what it says.",
		].join("\n"),
	};
}

/**
 * Say on the bus that a change landed, so the mesh keeps it in this
 * session's presence for an orchestrator to read rather than be told
 * (lib/internal/session/landings.ts). Named as `repo#number`, without
 * the owner, as people write it, so its web page goes beside it for the
 * launcher to open; `person` is the line the merge was asked to carry,
 * and `commit` the one it landed as, on the branch `onto`, by which the
 * launcher tells when a switch has brought it to the machine. The read
 * back runs once, straight after the merge: a host that answers it late
 * or not at all leaves the landing without the commit it would have
 * offered, and the launcher draws no line for it.
 */
async function sayMerged(
	bus: EventBus,
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	person: string | undefined,
	commit: string | undefined,
): Promise<void> {
	let read: {
		title?: string;
		url?: string;
		base?: string;
		mergeCommit?: string;
	} | null = null;
	try {
		read = await bound.proposal();
	} catch {
		// A change that can't be read now still landed; it is named alone.
	}
	const ref = change.label.slice(change.label.lastIndexOf("/") + 1);
	// The merge's own answer first; a host that didn't give one may say
	// it on the change read back.
	const landedAs = commit?.trim() || read?.mergeCommit;
	sayDid(bus, {
		kind: "merge",
		where: change.repo.key,
		title: read?.title ?? change.label,
	});
	sayLanded(bus, {
		ref,
		what: read?.title ?? `${change.label} merged`,
		...(read?.url ? { url: read.url } : {}),
		...(person ? { person } : {}),
		...(landedAs ? { commit: landedAs } : {}),
		...(read?.base ? { onto: read.base } : {}),
	});
}
/** The package config's `review` section, or nothing when it can't be read. */
export async function reviewSection(): Promise<unknown> {
	const loaded = await loadPackageConfig();
	return loaded.ok ? loaded.config.sections[REVIEW_SLUG] : undefined;
}

/** What a merge asks of the repo's own gate: its config, where and how to run it. */
export interface MergeGating {
	readonly review: unknown;
	readonly cwd: string;
	readonly run: RunGate;
}

/**
 * Why the repo's gate refuses this merge, or nothing when it names none
 * or lets it through (merge-gate.ts).
 */
async function gated(
	gating: MergeGating | undefined,
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	expectedHead: string | undefined,
): Promise<string | undefined> {
	if (!gating) return undefined;
	const gate = gateFor(gating.review, change.repo.key);
	if (gate.kind === "none") return undefined;
	if (gate.kind === "malformed") return `${gate.problem} Not merged.`;
	const head = expectedHead ?? (await bound.proposal())?.headCommit;
	if (!head) {
		return `${change.repo.key} has a merge gate, \`${gate.command}\`, and the head of ${change.label} couldn't be read to hand it. Merge with expectedHead set to the head's full sha.`;
	}
	return gateRefusal(gate, head, gating.cwd, gating.run);
}

/** Land the change. */
export async function merge(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
	bus?: EventBus,
	gating?: MergeGating,
): Promise<Answer> {
	// Checked here, before the gate, rather than left to the backend. Two
	// reasons. The backend that has this guard answers "Head branch was
	// modified", which names a cause that is false whenever the expectation
	// was stale or mistyped rather than the branch having moved, and it sends
	// the reader hunting a push nobody made. And not every backend enforces
	// it at all, so a guard the caller asked for would otherwise be silently
	// optional. The head this change is at is already in hand.
	const guard = await headGuard(bound, change.label, params.expectedHead);
	if ("refusal" in guard) return refuse(guard.refusal);
	const expectedHead = guard.head;
	// The repo's own say comes before the person is asked, so a head its
	// gate refuses never reaches a confirmation.
	const barred = await gated(gating, bound, change, expectedHead);
	if (barred) return refuse(barred);

	const decision = await confirmWrite(
		ctx,
		`Merge ${change.label}`,
		[
			`${GLYPH.target} ${change.label}`,
			params.method ? `   ${params.method}` : "   the repo's own merge policy",
			expectedHead
				? `   only if the head is still ${expectedHead}`
				: `   ${GLYPH.refused} unguarded: this merges whatever the head is now, including work pushed since you last looked`,
		].join("\n"),
	);
	if (!decision.approved) return declined(decision, "Not merged.");

	const outcome = await authoring.merge(change, {
		...(params.method === undefined ? {} : { method: params.method }),
		...(expectedHead === undefined ? {} : { expectedHead }),
	});

	// This used to say `merged` whatever came back, which is true on a backend
	// that merges when asked and a lie on one fronted by a queue, where the
	// change has been accepted for a batch that may still fail CI. The reader
	// of that sentence goes on to prune the branch and call the work done.
	if (outcome.kind === "enqueued") {
		// It lands when the queue reaches it, which is when it is said landed.
		noteQueued(change, params.person);
		return say(
			`${GLYPH.queued} ${change.label} enqueued${outcome.detail ? `: ${outcome.detail}` : ""}. It lands when the queue reaches it, and not at all if its checks fail, so do not prune the branch on the strength of this.`,
			{ ok: true, merged: false, enqueued: true },
		);
	}
	// Landing is the moment a change stops being in play, and nothing
	// used to say so, so the attachment outlived the change it named
	// and every later call still preferred it. A session that had
	// shipped eight changes carried eight of them, and each one
	// hijacked the calls whose subject is a repo rather than a change:
	// naming a checkout was answered with "the change in play is on
	// ...", once per pop, eight times over.
	//
	// Only here, and not for a change the queue has merely accepted.
	// That one lands when the queue reaches it and not at all if its
	// checks fail, which is exactly the state in which it is still
	// yours to watch.
	const letGo = await attachments().detach(change.label);
	if (bus) await sayMerged(bus, bound, change, params.person, outcome.commit);
	return say(
		`${GLYPH.lands} ${change.label} merged${outcome.commit ? ` at ${outcome.commit.slice(0, 12)}` : ""}.${letGo ? " Detached, since it is no longer what you are working on." : ""}`,
		{
			ok: true,
			merged: true,
			detached: letGo,
			...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
		},
	);
}
