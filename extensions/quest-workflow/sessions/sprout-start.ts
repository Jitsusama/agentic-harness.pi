/**
 * A sprouted session makes its own quest as it starts, from the seed the
 * node handed it (lib/internal/quest/sessions/sprout-seed.ts), rather
 * than asking its model to in prose: the quest is made, loaded, marked
 * as this sprout's and tied to the cell it came from before the first
 * turn, and the first words say only what is left to do.
 *
 * Once only. A start that finds a quest loaded, or a quest already
 * marked as this sprout's, makes none and says nothing, so a replayed
 * environment never makes a second one. Whatever goes wrong before the
 * quest exists leaves the node's prose words to be said, as before.
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
import { type RunProgram, runProgram } from "../../../lib/mesh/sprout.ts";
import { pendingWords } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import { create } from "../verbs/lifecycle.ts";

/** How long a tie to the map may take before the start goes on without it. */
const TIE_PATIENCE_MS = 15_000;

/** Makes a quest as `quest create` does, for a test to stand in for. */
export type Create = (
	params: Parameters<typeof create>[3],
) => Promise<QuestResult>;

/** What a sprout's start reaches beyond the quest state. */
export interface SproutStartDeps {
	readonly create: Create;
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
	sessionId: string | undefined,
	deps: SproutStartDeps = {
		create: (params) => create(state, pi, ctx, params),
		run: runProgram,
	},
): Promise<void> {
	const hints = pendingWords(ctx).hints;
	const seed = sproutSeedFrom(hints?.sprout);
	if (!hints || !seed) return;
	const alias = sproutAlias(seed, sessionId ?? "");
	if (state.questId || !alias.value || madeBefore(state, alias)) {
		// Made already, or this start is on another quest: the prose would
		// only ask for a second one.
		hints.firstWords = "";
		return;
	}
	const made = await makeQuest(seed, deps.create);
	const id = made.ok ? made.details?.id : undefined;
	if (typeof id !== "string") return;
	aliasAdd(state, {
		action: "alias-add",
		id,
		ref: `${alias.type}:${alias.value}`,
	});
	const tied = await tie(id, seed.from, ctx.cwd, deps.run);
	hints.firstWords = sproutedWords(id, seed, tied);
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

/** Whether a quest already carries this sprout's alias. */
function madeBefore(
	state: QuestState,
	alias: { type: string; value: string },
): boolean {
	const { index } = discoverQuests(state.questsRoot);
	return lookupAliasDetail(buildAliasIndex(index), alias).kind !== "miss";
}

/**
 * Create the quest from the link, whose page names and seeds it, with
 * the words as its note; else from the words. A link no ref type reads,
 * or whose page gives no title, makes it from the words, or from the
 * link itself as its title.
 */
async function makeQuest(seed: SproutSeed, make: Create): Promise<QuestResult> {
	const base = {
		action: "create",
		kind: "quest",
		priority: "driving",
	} as const;
	if (seed.link) {
		const linked = await make({
			...base,
			url: seed.link,
			...(seed.words ? { note: seed.words } : {}),
		});
		if (linked.ok) return linked;
	}
	const title = seed.words ? titleFromWords(seed.words) : seed.link;
	const note = [seed.words, seed.link].filter(Boolean).join("\n\n");
	return make({ ...base, title: title ?? "", note });
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
