/**
 * A sprouted session makes its own quest as it starts, from the seed the
 * node handed it (lib/internal/quest/sessions/sprout-seed.ts), rather
 * than asking its model to in prose: the quest is made, loaded, marked
 * as this sprout's and tied to the cell it came from before the first
 * turn, and the first words say only what is left to do.
 *
 * Once only. A start that finds a quest loaded says nothing; one that
 * finds a quest already marked as this sprout's, or already holding its
 * link, loads that one and makes none, so a replayed environment or a
 * known page never makes a second. Only a seed with its own id can be
 * marked. Whatever goes wrong before the quest exists leaves the node's
 * prose words to be said, as before; once it exists, the words say it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { aliasAdd } from "../../../lib/core/quest/verbs/alias.ts";
import type { QuestResult } from "../../../lib/core/quest/verbs/shared.ts";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../../lib/internal/quest/creation/alias-index.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery/discovery.ts";
import {
	type SproutSeed,
	sproutAlias,
	sproutedWords,
	sproutSeedFrom,
	type Tied,
	tieArguments,
	titleFromWords,
} from "../../../lib/internal/quest/sessions/sprout-seed.ts";
import { isSealedStatus } from "../../../lib/internal/quest/status.ts";
import { type RunProgram, runProgram } from "../../../lib/mesh/sprout.ts";
import { parseRef } from "../../../lib/refs/index.ts";
import { pendingWords } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import { create, load } from "../verbs/lifecycle.ts";

/** How long a tie to the map may take before the start goes on without it. */
const TIE_PATIENCE_MS = 15_000;

/** Makes a quest as `quest create` does, for a test to stand in for. */
export type Create = (
	params: Parameters<typeof create>[3],
) => Promise<QuestResult>;

/** Loads quest `id` as `quest load` does, for a test to stand in for. */
export type Load = (id: string) => Promise<QuestResult>;

/** What a sprout's start reaches beyond the quest state. */
export interface SproutStartDeps {
	readonly create: Create;
	readonly load: Load;
	readonly run: RunProgram;
}

/**
 * Make, mark and tie the quest a sprout's seed asks for, and leave the
 * words its first turn is told in the start's hints. Does nothing when
 * the start read no seed.
 */
export async function startSprouted(
	state: QuestState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	deps: SproutStartDeps = {
		create: (params) => create(state, pi, ctx, params),
		load: (id) => load(state, pi, ctx, { action: "load", id }),
		run: runProgram,
	},
): Promise<void> {
	const hints = pendingWords(ctx).hints;
	const seed = sproutSeedFrom(hints?.sprout);
	if (!hints || !seed) return;
	if (state.questId) {
		// This start restored its quest: the prose would only ask for a
		// second one.
		hints.firstWords = "";
		return;
	}
	const alias = sproutAlias(seed);
	const replayed = alias ? questWith(state, alias) : undefined;
	if (replayed?.sealed) {
		// Its quest was made and has since ended: the work is done.
		hints.firstWords = "";
		return;
	}
	// A sealed quest holding the link is finished work, never carried on:
	// the sprout makes its own, holding the link in its note.
	const linked = linkedQuest(state, seed);
	const held = replayed?.id ?? (linked?.sealed ? undefined : linked?.id);
	const id = held ?? (await madeId(seed, deps.create, linked?.sealed !== true));
	if (!id) return;
	let peers: string | undefined;
	if (held) {
		const loaded = await deps.load(held);
		if (!loaded.ok) return;
		peers = peersIn(loaded.message);
	}
	const joined = held !== undefined ? { peers } : undefined;
	// Said now, so a throw past here still tells the model its quest is
	// there, never the prose that asks it to make one.
	hints.firstWords = sproutedWords(id, seed, { kind: "none" }, joined);
	if (alias && held === undefined) {
		aliasAdd(state, {
			action: "alias-add",
			id,
			ref: `${alias.type}:${alias.value}`,
		});
	}
	const tied = await tie(id, seed.from, ctx.cwd, deps.run);
	hints.firstWords = sproutedWords(id, seed, tied, joined);
}

/**
 * What a load said of other live sessions on the quest (peers.ts's
 * peersSaid), so a sprout joining it is told who else is there.
 */
function peersIn(message: string): string | undefined {
	return message.match(
		/(?:Another live pi session is|\d+ other live pi sessions are) on [^\n]*/u,
	)?.[0];
}

/**
 * The id of the quest made for `seed`, or nothing when none was; made
 * from its link's page only while `linkable`, since a link a sealed
 * quest holds can't mark another.
 */
async function madeId(
	seed: SproutSeed,
	make: Create,
	linkable: boolean,
): Promise<string | undefined> {
	const made = await makeQuest(seed, make, linkable);
	const id = made.ok ? made.details?.id : undefined;
	return typeof id === "string" ? id : undefined;
}

/**
 * Say nothing of a sprout's seed on a start that restored a quest
 * instead: its environment was replayed onto a session that made its
 * quest before, and the node's prose would only ask for a second one.
 */
export function hushReplayedSprout(
	state: QuestState,
	ctx: ExtensionContext,
): void {
	const hints = pendingWords(ctx).hints;
	if (hints && state.questId && sproutSeedFrom(hints.sprout)) {
		hints.firstWords = "";
	}
}

/** A quest found holding an alias, and whether it has ended. */
interface Found {
	readonly id: string;
	readonly sealed: boolean;
}

/** The one quest carrying `alias`, if exactly one does. */
function questWith(
	state: QuestState,
	alias: { type: string; value: string },
): Found | undefined {
	const { index } = discoverQuests(state.questsRoot);
	const found = lookupAliasDetail(buildAliasIndex(index), alias);
	if (found.kind !== "hit") return undefined;
	const status = index.quests.get(found.questId)?.doc.frontMatter.status;
	return { id: found.questId, sealed: isSealedStatus(status) };
}

/** The quest already holding the seed's link, if one does. */
function linkedQuest(state: QuestState, seed: SproutSeed): Found | undefined {
	const ref = seed.link ? parseRef(seed.link) : undefined;
	return ref ? questWith(state, ref) : undefined;
}

/**
 * Create the quest from the link, whose page names and seeds it, with
 * the words as its note. A page that gives no title makes it from the
 * words, or the link itself, as its title, still marked with the link's
 * alias; a link no ref type reads makes it from those alone.
 */
async function makeQuest(
	seed: SproutSeed,
	make: Create,
	linkable: boolean,
): Promise<QuestResult> {
	const base = {
		action: "create",
		kind: "quest",
		priority: "driving",
	} as const;
	const title = (seed.words ? titleFromWords(seed.words) : seed.link) ?? "";
	if (linkable && seed.link && parseRef(seed.link)) {
		const note = seed.words ? { note: seed.words } : {};
		const linked = await make({ ...base, url: seed.link, ...note });
		if (linked.ok) return linked;
		return make({ ...base, url: seed.link, title, ...note });
	}
	const note = [seed.words, seed.link].filter(Boolean).join("\n\n");
	return make({ ...base, title, note });
}

/** Tie quest `id` to the cell it came from, saying how it went. */
async function tie(
	id: string,
	from: string | undefined,
	cwd: string,
	run: RunProgram,
): Promise<Tied> {
	if (!from) return { kind: "none" };
	const ran = await run("mycelium", tieArguments(id, from), {
		cwd,
		timeoutMs: TIE_PATIENCE_MS,
	});
	if (ran.code === 0) return { kind: "tied", from };
	const why = ran.missing
		? "there is no mycelium here"
		: ran.timedOut
			? "the node didn't answer in time"
			: ran.stderr.trim().split("\n").pop() ||
				`it ended with ${ran.code ?? "no code"}`;
	return { kind: "failed", from, why };
}
