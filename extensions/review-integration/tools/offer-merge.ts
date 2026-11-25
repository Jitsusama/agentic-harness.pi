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
import { areasOf } from "../../../lib/internal/session/changed-areas.ts";
import { sayDid } from "../../../lib/internal/session/events.ts";
import { sayLanded } from "../../../lib/internal/session/landings.ts";
import { changedPaths } from "../changed-paths.ts";
import { REVIEW_SLUG } from "../config.ts";
import { attachments } from "../engine.ts";
import {
	baseTip,
	type Gate,
	gateFor,
	gateRefusal,
	missingCheckout,
	type RunGate,
} from "../merge-gate.ts";
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
 * offered, and the launcher draws no line for it. `areas` are the
 * areas its diff touched, by which the mesh says what its quest works
 * on, read beside the read back and waited on for a bounded time
 * (changed-paths.ts): a diff that can't be read in that time leaves the
 * landing without them rather than holding up the merge's answer.
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
	const pathsRead = changedPaths(bound);
	try {
		read = await bound.proposal();
	} catch {
		// A change that can't be read now still landed; it is named alone.
	}
	const areas = areasOf(await pathsRead);
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
		...(areas.length > 0 ? { areas } : {}),
	});
}

/**
 * The package config's `review` section, or why the config couldn't be
 * read: a file that doesn't parse is not one naming no gate, or a stray
 * comma would turn every repo's gate off without a word.
 */
export async function reviewSection(): Promise<{
	review?: unknown;
	unread?: string;
}> {
	const loaded = await loadPackageConfig();
	return loaded.ok
		? { review: loaded.config.sections[REVIEW_SLUG] }
		: { unread: loaded.error };
}

/**
 * What a merge asks of the repo's own gate: its config, or why that
 * couldn't be read, and where and how to run it.
 */
export interface MergeGating {
	readonly review?: unknown;
	readonly unread?: string;
	readonly cwd: string;
	readonly run: RunGate;
}

/**
 * Why the repo's gate refuses this merge, or the head it let through:
 * nothing when the repo names no gate (merge-gate.ts). The gate is handed
 * the head as the backend reports it, always the full sha, and a backend
 * that reports none can't be gated. Once it passes, the head and where
 * the base is on origin are read again, so a push or another merge
 * landing while the gate ran is refused here whether or not the backend
 * keeps the guard. A push during the confirmation that follows is left to
 * the backend's guard, which the head is handed to; the base, which no
 * backend guards, is handed back to be read once more after it. A gate
 * whose base is queued has its head read again alone, as `queuedGate`
 * says, and hands back no base.
 */
async function gated(
	gating: MergeGating | undefined,
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	expectedHead: string | undefined,
): Promise<
	{ refused: string } | { passed?: string; base?: { name: string; at: string } }
> {
	if (!gating) return {};
	if (gating.unread !== undefined) {
		return {
			refused: `${gating.unread.replace(/\.$/, "")}. So whether ${change.repo.key} names a merge gate can't be known, and nothing was merged; mend the file, then merge again.`,
		};
	}
	const gate = gateFor(gating.review, change.repo.key);
	if (gate.kind === "none") return {};
	if (gate.kind === "malformed")
		return { refused: `${gate.problem} Not merged.` };
	// Read here whether or not an expectation was given: one the backend
	// couldn't check is a typed prefix, and a head nothing can read again
	// after the gate would refuse only once the gate had spent its time.
	const read = await bound.proposal();
	const head = read?.headCommit;
	const base = read?.base ?? "";
	if (!head) {
		return {
			refused: `${change.repo.key} has a merge gate, \`${gate.command}\`, but ${bound.provider.id} doesn't report the head of ${change.label}, so no gate can be held to one. Not merged.`,
		};
	}
	if (expectedHead !== undefined && !head.startsWith(expectedHead)) {
		return {
			refused: `${change.label} moved to ${head.slice(0, 12)} before its merge gate ran, not ${expectedHead.slice(0, 12)}. Not merged; read the head, then merge with what it says.`,
		};
	}
	const missing = await missingCheckout(gate, gating.cwd);
	if (missing !== undefined) return { refused: missing };
	if (gate.queued) {
		return await queuedGate(gate, head, base, bound, change, gating);
	}
	const before = await baseTip(base, gating.cwd, gating.run);
	if ("unread" in before) {
		return {
			refused: `Where ${change.label}'s base is on origin couldn't be read in ${gating.cwd} (${before.unread}), so a merge landing while the gate ran couldn't be told. Not merged; ${before.fix}.`,
		};
	}
	const refused = await gateRefusal(gate, head, gating.cwd, gating.run);
	if (refused !== undefined) return { refused };
	const moved = await headMovedWhileGated(head, bound, change);
	if (moved !== undefined) return { refused: moved };
	const passed = `The merge gate passed ${head.slice(0, 12)}`;
	const after = await baseTip(base, gating.cwd, gating.run);
	if ("unread" in after) {
		return {
			refused: `${passed}, but where ${change.label}'s base is on origin couldn't be read again (${after.unread}), so a merge landing while it ran couldn't be ruled out. Not merged; ${after.fix}.`,
		};
	}
	if (after.at !== before.at) {
		return {
			refused: `${base} moved on origin from ${before.at.slice(0, 12)} to ${after.at.slice(0, 12)} while the merge gate read ${head.slice(0, 12)}, so what would merge onto it is a pair nothing built. Not merged; rebase onto it and merge again.`,
		};
	}
	return { passed: head, base: { name: base, at: after.at } };
}

/**
 * A gate on a forge whose queue lands the change on main's newest tip:
 * the head is held to what the gate read, as every gate's is, but the
 * base is neither read nor handed on to be read after approval, since
 * the queue, not this merge, chooses what the change lands on. A change
 * that names no base is still refused, as an unqueued gate refuses it.
 */
async function queuedGate(
	gate: Gate,
	head: string,
	base: string,
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	gating: MergeGating,
): Promise<{ refused: string } | { passed: string }> {
	if (base === "") {
		return {
			refused: `${change.label} names no base, so the queue it would join can't be told. Not merged; a gated merge needs the base it lands on.`,
		};
	}
	const refused = await gateRefusal(gate, head, gating.cwd, gating.run);
	if (refused !== undefined) return { refused };
	const moved = await headMovedWhileGated(head, bound, change);
	return moved === undefined ? { passed: head } : { refused: moved };
}

/**
 * Why the change's head, read again once its gate passed, is not the
 * one the gate read, or nothing when it still is.
 */
async function headMovedWhileGated(
	head: string,
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
): Promise<string | undefined> {
	const passed = `The merge gate passed ${head.slice(0, 12)}`;
	let now: string | undefined;
	try {
		now = (await bound.proposal())?.headCommit;
	} catch (error) {
		return `${passed}, but reading the head of ${change.label} again failed: ${error instanceof Error ? error.message : String(error)}. Not merged; merge again once it can be read.`;
	}
	if (!now) {
		return `${passed}, but the head of ${change.label} couldn't be read again afterwards to show nothing landed while it ran. Not merged.`;
	}
	if (now !== head) {
		return `${change.label} moved to ${now.slice(0, 12)} while its merge gate read ${head.slice(0, 12)}, so what would merge is not what the gate passed. Not merged; merge again to gate the new head.`;
	}
	return undefined;
}

/**
 * Why a merge the person approved is refused now, or nothing: the base
 * is read once more, since a merge landing while they were asked would
 * put a pair nothing built onto it, and no backend guards the base.
 */
async function baseMovedWhileAsked(
	gating: MergeGating | undefined,
	base: { name: string; at: string } | undefined,
	change: NonNullable<ReturnType<typeof hostedChange>>,
): Promise<string | undefined> {
	if (!gating || !base) return undefined;
	const now = await baseTip(base.name, gating.cwd, gating.run);
	if ("unread" in now) {
		return `Where ${change.label}'s base is on origin couldn't be read again after the merge was approved (${now.unread}), so a merge landing meanwhile couldn't be ruled out. Not merged; ${now.fix}.`;
	}
	if (now.at === base.at) return undefined;
	return `${base.name} moved on origin from ${base.at.slice(0, 12)} to ${now.at.slice(0, 12)} while the merge was being approved, so what would merge onto it is a pair nothing built. Not merged; rebase onto it and merge again.`;
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
	// The repo's own say comes before the person is asked, so a head its
	// gate refuses never reaches a confirmation.
	const said = await gated(gating, bound, change, guard.head);
	if ("refused" in said) return refuse(said.refused);
	const expectedHead = guard.head ?? said.passed;

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
	const moved = await baseMovedWhileAsked(
		gating,
		"base" in said ? said.base : undefined,
		change,
	);
	if (moved !== undefined) return refuse(moved);

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
