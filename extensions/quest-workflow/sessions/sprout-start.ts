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
import { removeAliasesFromQuest } from "../../../lib/core/quest/front-matter.ts";
import { aliasAdd } from "../../../lib/core/quest/verbs/alias.ts";
import type { QuestResult } from "../../../lib/core/quest/verbs/shared.ts";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../../lib/internal/quest/creation/alias-index.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery/discovery.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/fields/mutate.ts";
import { withServed } from "../../../lib/internal/quest/fields/serves.ts";
import {
	needAsker,
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
import { parseRef, type Ref, urlForRef } from "../../../lib/refs/index.ts";
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
	const replayed = alias ? questsWith(state, alias)[0] : undefined;
	if (replayed?.sealed) {
		// Its quest was made and has since ended: the work is done, and
		// the prose would only ask for another.
		hints.firstWords = `This session was sprouted for quest ${replayed.id}, which has since ended, so its work is done. Take on nothing new; say so in a line.`;
		return;
	}
	// A sealed quest holding the link is finished work, never carried on:
	// the sprout makes its own, holding the link in its note and marked
	// as the link's sprout, so the next sprout of it joins this one.
	const linked = linkedQuest(state, seed);
	const held = replayed?.id ?? (linked?.sealed ? undefined : linked?.id);
	const id = held ?? (await madeId(seed, deps.create, linked === undefined));
	if (!id) return;
	let peers: string | undefined;
	if (held) {
		const loaded = await deps.load(held);
		if (!loaded.ok) return;
		const said = loaded.details?.peers;
		peers = typeof said === "string" ? said : undefined;
	}
	const joined = held !== undefined ? { peers } : undefined;
	// Said now, so a throw past here still tells the model its quest is
	// there, never the prose that asks it to make one.
	const linkIs = linkIsPlace(seed) ? "place" : "work";
	hints.firstWords = sproutedWords(id, seed, { kind: "none" }, joined, linkIs);
	if (held === undefined) {
		const link = linked ? sproutLink(seed) : undefined;
		// The link's mark moves off any ended quest holding it, since an
		// alias goes on one quest only, and the next sprout must find this.
		if (link) unmarkEnded(state, link);
		const marks = [alias, link].filter((one) => one !== undefined);
		for (const mark of marks) {
			aliasAdd(state, {
				action: "alias-add",
				id,
				ref: `${mark.type}:${mark.value}`,
			});
		}
	} else if (!replayed && alias) {
		// A live quest it joined takes its mark too, so a replay after that
		// quest ends is told its work is done, never starts it again.
		aliasAdd(state, {
			action: "alias-add",
			id,
			ref: `${alias.type}:${alias.value}`,
		});
	}
	servesNeed(state, id, seed);
	const tied = await tie(id, seed.from, ctx.cwd, deps.run);
	hints.firstWords = sproutedWords(id, seed, tied, joined, linkIs);
}

/**
 * Record on quest `id`'s README the mesh need its sprout took on, so
 * its presence says whose need its cell serves and the node's forage
 * shows why it exists: the asker named by the need's id, what the words
 * asked (else the id), and since now. A quest it joined takes it too,
 * since its cell now serves that need as well; one already holding it
 * is left as it is. A README that can't be written leaves the quest
 * standing without it, since the work matters more than its lineage.
 */
function servesNeed(state: QuestState, id: string, seed: SproutSeed): void {
	const cell = seed.need ? needAsker(seed.need) : undefined;
	const dir = discoverQuests(state.questsRoot).index.quests.get(id)?.dir;
	if (!seed.need || !cell || !dir) return;
	const taken = {
		cell,
		need: seed.words || seed.need,
		since: new Date().toISOString(),
		id: seed.need,
	};
	mutateQuestFrontMatter(dir, (fm) => {
		const before = fm._extra?.serves;
		const serves = withServed(before, taken);
		if (JSON.stringify(serves) === JSON.stringify(before ?? [])) {
			return undefined;
		}
		return { ...fm, _extra: { ...fm._extra, serves } };
	});
}

/**
 * The id of the quest made for `seed`, or nothing when none was; made
 * from its link's page only while `linkable`, since a link another
 * quest holds can't mark a second.
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

/** A quest found holding an alias, its folder, and whether it has ended. */
interface Found {
	readonly id: string;
	readonly dir: string | undefined;
	readonly sealed: boolean;
}

/** Take `mark` off every ended quest carrying it. */
function unmarkEnded(
	state: QuestState,
	mark: { type: string; value: string },
): void {
	for (const one of questsWith(state, mark)) {
		if (one.sealed && one.dir) removeAliasesFromQuest(one.dir, [mark]);
	}
}

/** Every quest carrying `alias`, live ones first. */
function questsWith(
	state: QuestState,
	alias: { type: string; value: string },
): Found[] {
	const { index } = discoverQuests(state.questsRoot);
	const found = lookupAliasDetail(buildAliasIndex(index), alias);
	const ids =
		found.kind === "hit"
			? [found.questId]
			: found.kind === "collision"
				? found.questIds
				: [];
	return ids
		.map((id) => ({
			id,
			dir: index.quests.get(id)?.dir,
			sealed: isSealedStatus(index.quests.get(id)?.doc.frontMatter.status),
		}))
		.sort((a, b) => Number(a.sealed) - Number(b.sealed));
}

/**
 * The ref the seed's link is a page of: read from the link less its
 * fragment, on the ref's own site, with no second address inside it. So
 * a link merely carrying another page's address in its path, query or
 * fragment joins no quest and takes no mark, while a reply's link in a
 * Slack thread, naming the thread in its query, still reads as it. A
 * place work happens in, such as a repository, is no piece of work, so
 * its link reads as no ref either.
 */
function linkRef(seed: SproutSeed): Ref | undefined {
	return linkRead(seed)?.ref;
}

/**
 * The seed's link as linkRef reads it: the page, less its fragment, and
 * the ref it's a page of. The page is what the quest is made from, so
 * create reads the same ref from it, never one a fragment carries.
 */
function linkRead(seed: SproutSeed): { page: string; ref: Ref } | undefined {
	const read = pageRead(seed);
	return read && !PLACES.has(read.ref.type) ? read : undefined;
}

/**
 * The seed's link, less its fragment, and the ref it's a page of, on
 * the ref's own site with no second address inside it, whether the ref
 * names work or a place work happens.
 */
function pageRead(seed: SproutSeed): { page: string; ref: Ref } | undefined {
	const link = seed.link ? webAddress(seed.link) : undefined;
	if (!link) return undefined;
	link.hash = "";
	const page = link.href;
	if (page.split("://").length > 2) return undefined;
	const ref = parseRef(page);
	const own = ref ? webAddress(urlForRef(ref) ?? "") : undefined;
	return ref && own && siteOf(own) === siteOf(link) ? { page, ref } : undefined;
}

/**
 * Ref types naming where work happens rather than a piece of it: every
 * sprout of a repository would otherwise join the first one's quest.
 */
const PLACES: ReadonlySet<string> = new Set(["github-repo"]);

/**
 * Whether the seed's link, read as pageRead reads it, names a place
 * work happens (PLACES), so its first words never call the page the
 * work. A link merely carrying a place's address is no place.
 */
function linkIsPlace(seed: SproutSeed): boolean {
	const read = pageRead(seed);
	return read ? PLACES.has(read.ref.type) : false;
}

/**
 * The refs naming the same work as `ref`: itself, and for a Slack thread
 * its parent message's own, and the reverse, since a reply's link reads
 * as the thread and the parent's link as the message, under one value.
 */
function sameWork(ref: Ref): Ref[] {
	const twin = SLACK_TWINS[ref.type];
	return twin ? [ref, { type: twin, value: ref.value }] : [ref];
}

/** Each Slack ref type and the one naming the same thread under its value. */
const SLACK_TWINS: Readonly<Record<string, string>> = {
	"slack-message": "slack-thread",
	"slack-thread": "slack-message",
};

/** `text` as a web address, or nothing where it isn't one. */
function webAddress(text: string): URL | undefined {
	try {
		return new URL(text);
	} catch {
		// Not a web address, so no page to be a ref's.
		return undefined;
	}
}

/** A web address's host, less any www., to compare sites by. */
function siteOf(url: URL): string {
	return url.host.replace(/^www\./u, "");
}

/**
 * The mark a sprout's own quest takes for a link a sealed quest holds,
 * since the link's own alias can't go on two quests.
 */
function sproutLink(
	seed: SproutSeed,
): { type: string; value: string } | undefined {
	const ref = linkRef(seed);
	return ref ? markOf(ref) : undefined;
}

/** The mark a sprout's own quest takes for `ref`. */
function markOf(ref: Ref): { type: string; value: string } {
	return { type: "sprout-link", value: `${ref.type}:${ref.value}` };
}

/**
 * The quest already holding the seed's link, a live one before one
 * ended: by the link's own alias, else by the mark an earlier sprout of
 * it took when the quest holding it had ended, each under any ref naming
 * the same work (sameWork).
 */
function linkedQuest(state: QuestState, seed: SproutSeed): Found | undefined {
	const ref = linkRef(seed);
	if (!ref) return undefined;
	const all = sameWork(ref).flatMap((one) => [
		...questsWith(state, one),
		...questsWith(state, markOf(one)),
	]);
	return all.find((one) => !one.sealed) ?? all[0];
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
	const read = linkable ? linkRead(seed) : undefined;
	if (read) {
		const note = seed.words ? { note: seed.words } : {};
		const linked = await make({ ...base, url: read.page, ...note });
		if (linked.ok) return linked;
		return make({ ...base, url: read.page, title, ...note });
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
	if (ran.timedOut) return { kind: "unsure", from };
	if (ran.neverRan) {
		return {
			kind: "failed",
			from,
			why: `it couldn't be started (${ran.neverRan})`,
		};
	}
	if (ran.missing || ran.noFolder) {
		const why = ran.missing
			? "there is no mycelium here"
			: "this session's folder is gone";
		return { kind: "failed", from, why, retry: false };
	}
	const why =
		ran.stderr.trim().split("\n").pop() ||
		`it ended with ${ran.code ?? "no code"}`;
	return { kind: "failed", from, why };
}
