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
 *
 * A sprout's first words, the node's prose and every word this start
 * sets in its place, go under the automated header (`started`), so a
 * sprout quoting the ask it was started for never reads in the log as
 * the person correcting it (pain points, 24 November, entry efd94b22).
 * Its reason marks them as the start's, which compaction still quotes
 * (lib/compaction/selection/units.ts), the ledger takes as starting a
 * run and the budget keeper judges as the ask, so no path loses its
 * ask, whether its quest was made, joined or never came.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { removeAliasesFromQuest } from "../../../lib/core/quest/front-matter.ts";
import { aliasAdd } from "../../../lib/core/quest/verbs/alias.ts";
import type { QuestResult } from "../../../lib/core/quest/verbs/shared.ts";
import {
	automatedText,
	START_WORDS_REASON,
	startWordsOf,
} from "../../../lib/internal/automated.ts";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../../lib/internal/quest/creation/alias-index.ts";
import { isId } from "../../../lib/internal/quest/creation/id.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery/discovery.ts";
import { appendHarnessLog } from "../../../lib/internal/quest/documents/harness-log.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/fields/mutate.ts";
import {
	needAsker,
	withServed,
} from "../../../lib/internal/quest/fields/serves.ts";
import {
	SPLIT_FROM,
	splitFromOf,
} from "../../../lib/internal/quest/fields/split-from.ts";
import {
	type SproutSeed,
	sproutAlias,
	sproutedWords,
	sproutSeedFrom,
	type Tied,
	tieArguments,
	titleFromWords,
	unrecordedSaid,
	wroteSaid,
} from "../../../lib/internal/quest/sessions/sprout-seed.ts";
import { isSealedStatus } from "../../../lib/internal/quest/status.ts";
import { drawsAsNothing } from "../../../lib/internal/unseen.ts";
import { type RunProgram, runProgram } from "../../../lib/mesh/sprout.ts";
import { parseRef, type Ref, urlForRef } from "../../../lib/refs/index.ts";
import { pendingWords } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import { create, load } from "../verbs/lifecycle.ts";

/** A start's own words, as no person's but still its ask. */
const started = (words: string): string =>
	automatedText(START_WORDS_REASON, words);

/** How long a tie to the map may take before the start goes on without it. */
const TIE_PATIENCE_MS = 15_000;

/**
 * The most of mycelium's last line a tie that didn't land quotes in the
 * session's first words: enough for a line of a reason, never a page. It
 * is only what mycelium last wrote, which a kill (SIGKILL) leaves unsaid,
 * so it is quoted as that, never as why.
 */
const MOST_QUOTED = 200;

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
	if (!hints?.sprout?.trim()) return;
	// The node's prose is marked before anything here can fail, so a seed
	// that won't read, a quest never made or loaded, or a throw still
	// leaves it the start's. Words under another header are marked too,
	// or no reader would take them as the start's ask.
	if (hints.firstWords && startWordsOf(hints.firstWords) === undefined) {
		hints.firstWords = started(hints.firstWords);
	}
	const seed = sproutSeedFrom(hints.sprout);
	if (!seed) return;
	if (state.questId) {
		// This start restored its quest: the prose would only ask for a
		// second one.
		hints.firstWords = "";
		return;
	}
	const alias = sproutAlias(seed);
	const joinMark = alias ? joinedMark(alias) : undefined;
	// Its own quest, else the live one it joined, each found by the mark
	// it left there; only the first is one it made.
	const made = alias ? questsWith(state, alias)[0] : undefined;
	const rejoined =
		made || !joinMark ? undefined : questsWith(state, joinMark)[0];
	const replayed = made ?? rejoined;
	if (replayed?.sealed) {
		// Its quest was made and has since ended: the work is done, and
		// the prose would only ask for another.
		hints.firstWords = started(
			`This session was sprouted for quest ${replayed.id}, which has since ended, so its work is done. Take on nothing new; say so in a line.`,
		);
		return;
	}
	// A sealed quest holding the link is finished work, never carried on:
	// the sprout makes its own, holding the link in its note and marked
	// as the link's sprout, so the next sprout of it joins this one.
	const linked = linkedQuest(state, seed);
	// A link a quest of forged id holds can't mark another, and create's
	// refusal would quote that id: the sprout's own quest holds it in its
	// note and the sprout's mark instead, so the next sprout joins it.
	const forged = linked === undefined && forgedHolds(state, seed);
	const held = replayed?.id ?? (linked?.sealed ? undefined : linked?.id);
	const id =
		held ?? (await madeId(seed, deps.create, linked === undefined && !forged));
	if (!id) return;
	let peers: string | undefined;
	if (held) {
		const loaded = await deps.load(held);
		if (!loaded.ok) return;
		const said = loaded.details?.peers;
		peers = typeof said === "string" ? said : undefined;
	}
	// Every other live quest holding the work, told on a replay too, whose
	// session is new and never heard the first one's words.
	const also = linked
		? [
				...new Set([...(linked.sealed ? [] : [linked.id]), ...linked.also]),
			].filter((one) => one !== id)
		: [];
	// A quest found already there is never tied by this start to the cell
	// that asked, which its words name instead: one it joined predates the
	// ask, and one whose mark didn't hold, or whose seed had no id, can't
	// be told from one.
	const askedBy = !made && seed.from ? { askedBy: seed.from } : {};
	const joined = held !== undefined ? { peers, also, ...askedBy } : undefined;
	// Said now, so a throw past here still tells the model its quest is
	// there, never the prose that asks it to make one.
	const linkIs = linkIsPlace(seed) ? "place" : "work";
	hints.firstWords = started(
		sproutedWords(id, seed, { kind: "none" }, joined, linkIs),
	);
	// A write whose quest's lock didn't come spins the thread for seconds,
	// and every write left would ask for it again, so once one throws this
	// start writes that quest no more: its tie and first words still go.
	let locked = false;
	// What each write this start couldn't make, and couldn't log, costs:
	// no log can say so, so the first words do, needing no lock.
	const unrecorded: string[] = [];
	// A mark is only lost where the quest doesn't hold it, which reading
	// the index, taking no lock, says: a verb whose own log threw had
	// written it first.
	const lost = (mark: { type: string; value: string }): boolean =>
		!idsWith(state, mark).includes(id);
	if (held === undefined) {
		const link = linked || forged ? sproutLink(seed) : undefined;
		// The link's mark moves off any ended quest holding it, since an
		// alias goes on one quest only, and the next sprout must find this.
		if (link) unmarkEnded(state, link);
		const marks = [
			...(alias ? [{ mark: alias, so: UNFOUND }] : []),
			...(link ? [{ mark: link, so: LINK_UNFOUND }] : []),
		];
		for (const [at, { mark, so }] of marks.entries()) {
			// A mark refused leaves the quest made, so it is still tied below
			// rather than left untied, and its log says what may not find it.
			// A refusal takes no lock, so its log is the first write to ask
			// for one, and a log whose lock didn't come stops the writes too.
			const got = marking(state, id, mark);
			const logged =
				got === "refused" ? markUnwritten(state, id, seed, mark, so) : "logged";
			if (logged === "unlogged") unrecorded.push(so);
			locked = got === "locked" || logged === "locked";
			if (locked) {
				const left = got === "locked" ? marks.slice(at) : marks.slice(at + 1);
				if (got !== "locked") unrecorded.push(so);
				unrecorded.push(
					...left.filter((one) => lost(one.mark)).map((one) => one.so),
				);
				break;
			}
		}
	} else if (!replayed && joinMark) {
		// A live quest it joined takes a mark of its own, so a replay after
		// that quest ends is told its work is done, never starts it again,
		// and a replay while it lives joins it again, never ties it. A mark
		// refused leaves the session working the quest it joined, its need
		// still recorded below, and its log says a replay after the quest
		// ends may start the work again.
		const got = marking(state, id, joinMark);
		const logged =
			got === "refused"
				? markUnwritten(state, id, seed, joinMark, RESTARTED)
				: "logged";
		locked = got === "locked" || logged === "locked";
		const missing = got === "locked" ? lost(joinMark) : logged !== "logged";
		if (missing) unrecorded.push(RESTARTED);
	}
	// A write whose lock didn't come sets `locked`, so the next write
	// doesn't wait out the same lock again.
	if (seed.need) {
		const served = servesNeed(state, id, seed, locked);
		locked ||= served === "locked";
		if (served !== "held") unrecorded.push(UNSERVED);
	}
	// Only a quest it made, or its own replayed, splits from and is
	// sprouted from the cell that asked: a live one it joined predates it,
	// and may be that very cell's own, so the map is left saying where it
	// really came from. A sprout the person started names no cell.
	const ownQuest = held === undefined || made !== undefined;
	if (ownQuest && seed.from) {
		const split = splitsFrom(state, id, seed.from, locked);
		locked ||= split === "locked";
		if (split !== "held") unrecorded.push(UNSPLIT);
	}
	const tied = ownQuest
		? await tie(id, seed.from, ctx.cwd, deps.run)
		: ({ kind: "none" } as const);
	// The first words reach only the model, so the host's own log keeps
	// what no quest log could, for whoever reads the machine later.
	if (unrecorded.length > 0) {
		process.stderr.write(
			`[quest-workflow] the sprout of ${id} could log none of what it missed: ${unrecorded.join("; ")}\n`,
		);
	}
	hints.firstWords = started(
		`${sproutedWords(id, seed, tied, joined, linkIs)}${unrecordedSaid(unrecorded)}`,
	);
}

/**
 * Record on quest `id`'s README the mesh need its sprout took on, so
 * its presence says whose need its cell serves and the node's forage
 * shows why it exists: the asker named by the need's id, what the words
 * asked (else the id), and since now. A quest it joined takes it too,
 * since its cell now serves that need as well; one already holding it
 * is left as it is. A README that can't be written, or whose lock
 * doesn't come, leaves the quest standing without it and the tie still
 * made, since the work matters more than its lineage. While `locked`
 * (an earlier write's lock didn't come) it writes nothing. Answers
 * whether the quest holds all the seed's need gives it to, read from
 * the index without a lock first, so a need with no cell to name, or
 * one already held, is never said to be missing; locked when the write
 * threw, as a lock that never came does.
 */
function servesNeed(
	state: QuestState,
	id: string,
	seed: SproutSeed,
	locked: boolean,
): Written {
	const cell = seed.need ? needAsker(seed.need) : undefined;
	if (!seed.need || !cell) return "held";
	const quest = discoverQuests(state.questsRoot).index.quests.get(id);
	if (!quest) return "unwritten";
	const taken = {
		cell,
		need: seed.words || seed.need,
		since: new Date().toISOString(),
		id: seed.need,
	};
	if (withServed(quest.doc.frontMatter._extra?.serves, taken) === undefined) {
		return "held";
	}
	if (locked) return "unwritten";
	return written(() =>
		mutateQuestFrontMatter(quest.dir, (fm) => {
			const serves = withServed(fm._extra?.serves, taken);
			return serves ? { ...fm, _extra: { ...fm._extra, serves } } : undefined;
		}),
	);
}

/** Whether a README write's field is now held, unwritten, or its lock didn't come. */
type Written = "held" | "unwritten" | "locked";

/**
 * Make a README write, answering whether it landed. A throw is a lock
 * that didn't come or a write that failed: the quest stands without its
 * lineage, the tie after this is still made, and no later write asks
 * for that lock again.
 */
function written(write: () => { ok: boolean }): Written {
	try {
		return write().ok ? "held" : "unwritten";
	} catch {
		return "locked";
	}
}

/**
 * Record on quest `id`'s README the cell `from` its work split from, so
 * its presence says so and the node's forage draws the split. A README
 * that can't be written, or whose lock doesn't come, leaves the quest
 * standing without it, as `servesNeed` does; while `locked` it writes
 * nothing. A split already recorded is kept, even naming another cell,
 * since the first start's claim is the one the map drew. Answers
 * whether the quest says a cell it split from.
 */
function splitsFrom(
	state: QuestState,
	id: string,
	from: string,
	locked: boolean,
): Written {
	const quest = discoverQuests(state.questsRoot).index.quests.get(id);
	if (!quest) return "unwritten";
	if (splitFromOf(quest.doc.frontMatter._extra?.[SPLIT_FROM]) !== undefined) {
		return "held";
	}
	if (locked) return "unwritten";
	// Read again under the lock, so a split another start recorded since
	// is kept rather than overwritten, and the file left as it is.
	return written(() =>
		mutateQuestFrontMatter(quest.dir, (fm) =>
			splitFromOf(fm._extra?.[SPLIT_FROM]) !== undefined
				? undefined
				: { ...fm, _extra: { ...fm._extra, [SPLIT_FROM]: from } },
		),
	);
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

/**
 * Take `mark` off every ended quest carrying it. One whose lock doesn't
 * come keeps it, so the made quest's link mark is refused and logged,
 * and the start still marks and ties the quest it made.
 */
function unmarkEnded(
	state: QuestState,
	mark: { type: string; value: string },
): void {
	for (const one of questsWith(state, mark)) {
		if (!one.sealed || !one.dir) continue;
		try {
			removeAliasesFromQuest(one.dir, [mark]);
		} catch {
			// A lock that didn't come or a write that failed: the ended quest
			// keeps the mark, and the made quest's own is refused and logged.
		}
	}
}

/**
 * The mark a live quest a sprout joined takes, apart from the one its
 * own quest takes, so a replay can tell the quest it made, which is
 * tied to its asker, from one it joined, which never is.
 */
function joinedMark(alias: { type: string; value: string }): {
	type: string;
	value: string;
} {
	return { type: "sprout-joined", value: alias.value };
}

/** What a made quest's missing mark costs a replay of its sprout. */
const UNFOUND = "a replay of it may not find this quest and make another";

/** What a made quest's missing link mark costs the next sprout of its link. */
const LINK_UNFOUND =
	"the next sprout of its link may not find this quest and make another";

/** What a joined quest's missing mark costs a replay of its sprout. */
const RESTARTED =
	"a replay of it after this quest ends may start its work again";

/** What a split its quest doesn't record costs the node's forage. */
const UNSPLIT =
	"the cell it split from isn't recorded on the quest, so the map can't draw the split";

/** What a need its quest doesn't record costs the node's forage. */
const UNSERVED =
	"the need it serves isn't recorded on the quest, so the node can't say whose need its cell serves";

/**
 * What became of a mark: written; refused, by the alias verb's answer
 * (held by another quest, or a README it couldn't read); or locked,
 * when it threw, as a lock that never came does, whether or not the mark
 * landed first.
 */
type Marking = "written" | "refused" | "locked";

/** Add `mark` to quest `id`, saying what became of it. */
function marking(
	state: QuestState,
	id: string,
	mark: { type: string; value: string },
): Marking {
	const ref = `${mark.type}:${mark.value}`;
	try {
		return aliasAdd(state, { action: "alias-add", id, ref }).ok
			? "written"
			: "refused";
	} catch {
		// A lock that didn't come, or a write that failed; the verb also
		// throws when the lock for its own log line doesn't come, after the
		// mark has landed, which the start reads the index to tell.
		return "locked";
	}
}

/**
 * Say in quest `id`'s harness log that its sprout's `mark` wasn't
 * written, and `so`, what that costs a replay of `seed`; a log that
 * can't be written leaves the quest as the start left it. Answers
 * whether it's logged, locked when the log threw, as a lock that never
 * came does, so the start asks the quest no more, or unlogged when the
 * quest had no folder to log in.
 */
function markUnwritten(
	state: QuestState,
	id: string,
	seed: SproutSeed,
	mark: { type: string; value: string },
	so: string,
): "logged" | "locked" | "unlogged" {
	const dir = discoverQuests(state.questsRoot).index.quests.get(id)?.dir;
	if (!dir) return "unlogged";
	try {
		appendHarnessLog(
			dir,
			`sprout ${seed.id ?? "with no id"}: its mark ${mark.type}:${mark.value} wasn't written, so ${so}`,
		);
		return "logged";
	} catch {
		// A log whose lock didn't come, or a write that failed: the quest
		// stands as the start left it, and the first words say what this
		// note would have.
		return "locked";
	}
}

/** The ids of every quest carrying `alias`, as their READMEs spell them. */
function idsWith(
	state: QuestState,
	alias: { type: string; value: string },
): string[] {
	const { index } = discoverQuests(state.questsRoot);
	const found = lookupAliasDetail(buildAliasIndex(index), alias);
	return found.kind === "hit"
		? [found.questId]
		: found.kind === "collision"
			? [...found.questIds]
			: [];
}

/**
 * Whether a quest whose README's id isn't spelled as one holds the
 * seed's link, under any ref naming the same work, which questsWith
 * never finds.
 */
function forgedHolds(state: QuestState, seed: SproutSeed): boolean {
	const ref = linkRef(seed);
	return (
		ref !== undefined &&
		sameWork(ref).some((one) => idsWith(state, one).some((id) => !isId(id)))
	);
}

/** Every quest carrying `alias`, live ones first. */
function questsWith(
	state: QuestState,
	alias: { type: string; value: string },
): Found[] {
	const { index } = discoverQuests(state.questsRoot);
	const ids = idsWith(state, alias);
	// A README's id is its own front matter's, which can say anything, and
	// a sprout's first words name the quest it found: one not spelled as an
	// id is never joined, replayed or named.
	return ids
		.filter(isId)
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
 * work. A link merely carrying a place's address is no place. GitHub's
 * own ways of linking a place count too, which parseRef reads as no
 * ref: up to three parts of a path name an owner, a repository or one
 * of its tabs (?tab=readme-ov-file, /pulls, /milestones, /settings), an
 * organisation's tabs (/orgs/o/repositories) or one of GitHub's own
 * pages (/topics/rust, /search), but for what GitHub keeps of one
 * person's (GITHUB_ITEMS). Deeper, a page is the work only where its
 * tab names a piece of it (gitHubWork), and else a place: a folder
 * (/tree), a label's list (/labels/bug), a setting or a team. One
 * advisory (/advisories/GHSA-...) is the work. A page read wrongly as a
 * place asks the person for the work, which costs less than one read
 * wrongly as the work, filling a quest from a list.
 */
function linkIsPlace(seed: SproutSeed): boolean {
	const url = seed.link ? webAddress(seed.link) : undefined;
	const onGitHub = url !== undefined && siteOf(url) === "github.com";
	const path = url ? url.pathname.split("/").filter((part) => part !== "") : [];
	// Before pageRead: parseRef reads /advisories/GHSA-... as an owner's
	// repository.
	if (onGitHub && path[0] === GITHUB_ADVISORIES) return path.length === 1;
	const read = pageRead(seed);
	if (read) return PLACES.has(read.ref.type);
	if (!onGitHub) return false;
	if (GITHUB_ITEMS.has(path[0] ?? "")) return path.length === 1;
	return path.length <= GITHUB_PLACE_DEPTH || !gitHubWork(path);
}

/**
 * Whether a GitHub path past GITHUB_PLACE_DEPTH names a piece of work by
 * its tab. A file, a commit, a comparison, a release, a wiki page or an
 * upload is one once its tab has as many parts below it as
 * GITHUB_WORK_TABS says. A pull request, an issue, a discussion, a
 * milestone, a project or a run is one by its number. One advisory under
 * /security is one by its id, and one alert there, or one run under
 * /actions, by its number, but never their lists. A form or an index
 * (isPiece) is never one.
 */
function gitHubWork(path: readonly string[]): boolean {
	const tab = path[GITHUB_TAB] ?? "";
	const below = path.slice(GITHUB_TAB + 1);
	const fewest = GITHUB_WORK_TABS.get(tab);
	if (fewest !== undefined)
		return below.length >= fewest && isPiece(tab, below[0]);
	if (GITHUB_NUMBERED_TABS.has(tab)) return NUMBERED.test(below[0] ?? "");
	const list = below[0] ?? "";
	if (GITHUB_WORK_UNDER.get(tab)?.has(list) !== true) return false;
	return list === GITHUB_ADVISORIES
		? isPiece(list, below[1])
		: NUMBERED.test(below[1] ?? "");
}

/**
 * Whether a part of a GitHub path under `tab` names a piece rather than
 * a form to make or change one (/releases/new, /advisories/new) or a
 * wiki's index (/wiki/_pages), which GitHub starts with an underscore.
 * On any other tab the part is a ref or an id, which may read new.
 */
function isPiece(tab: string, part: string | undefined): boolean {
	if (part === undefined) return false;
	if (tab === GITHUB_WIKI) return !part.startsWith("_");
	return GITHUB_FORMS.get(tab)?.has(part) !== true;
}

/** A part GitHub numbers its pieces by. */
const NUMBERED = /^\d+$/u;

/** GitHub's advisories, each of which (/advisories/GHSA-...) is the work. */
const GITHUB_ADVISORIES = "advisories";

/** GitHub's wiki, whose own pages start with an underscore. */
const GITHUB_WIKI = "wiki";

/** GitHub's parts naming a form to make or change a piece, by tab. */
const GITHUB_FORMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["releases", new Set(["new", "edit"])],
	[GITHUB_ADVISORIES, new Set(["new"])],
]);

/**
 * What GitHub keeps of one person's under its own first part, each the
 * work: an upload (/user-attachments/assets/...), often the report
 * itself, and a Copilot conversation (/copilot/c/...).
 */
const GITHUB_ITEMS: ReadonlySet<string> = new Set([
	"user-attachments",
	"copilot",
]);

/**
 * The most parts of a GitHub path naming a place whatever they are: an
 * owner, a repository and one of its tabs.
 */
const GITHUB_PLACE_DEPTH = 3;

/**
 * Where a GitHub path names its tab: after an owner and a repository, or
 * after /orgs or /users and their name.
 */
const GITHUB_TAB = 2;

/**
 * GitHub's tabs whose pages are each a piece of work, with the fewest
 * parts below the tab that name one: a ref and a file for a file's
 * pages; one for a commit, a comparison, a release or a wiki page; an
 * id and a name for an upload kept in a repository.
 */
const GITHUB_WORK_TABS: ReadonlyMap<string, number> = new Map([
	["blob", 2],
	["blame", 2],
	["raw", 2],
	["commit", 1],
	["compare", 1],
	["releases", 1],
	["wiki", 1],
	["files", 2],
	["assets", 2],
]);

/** GitHub's tabs whose numbered pages are each a piece of work. */
const GITHUB_NUMBERED_TABS: ReadonlySet<string> = new Set([
	"pull",
	"issues",
	"discussions",
	"milestone",
	"projects",
	"runs",
]);

/**
 * GitHub's tabs holding lists whose every page below them is a piece of
 * work: an advisory or an alert under /security, a run under /actions.
 */
const GITHUB_WORK_UNDER: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	[
		"security",
		new Set(["advisories", "code-scanning", "dependabot", "secret-scanning"]),
	],
	["actions", new Set(["runs"])],
]);

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
function linkedQuest(
	state: QuestState,
	seed: SproutSeed,
): (Found & { also: string[] }) | undefined {
	const ref = linkRef(seed);
	if (!ref) return undefined;
	const all = sameWork(ref).flatMap((one) => [
		...questsWith(state, one),
		...questsWith(state, markOf(one)),
	]);
	const found = all.find((one) => !one.sealed) ?? all[0];
	if (!found) return undefined;
	// Two live quests holding one work is a collision the alias index
	// would refuse; joined, the others are named rather than passed over.
	const also = [
		...new Set(
			all
				.filter((one) => !one.sealed && one.id !== found.id)
				.map((one) => one.id),
		),
	];
	return { ...found, also };
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

/**
 * What ends a line in what mycelium writes, Unicode's own ends too: the
 * next line (U+0085) and the line and paragraph separators.
 */
const LINE_ENDS = /\r?\n|\r|\u0085|\u2028|\u2029/u;

/** The code point that opens a terminal's escape sequence. */
const ESCAPE_POINT = 0x1b;

/** The escape, as text. */
const ESC = String.fromCodePoint(ESCAPE_POINT);

/**
 * A terminal's escape sequence, dropped whole so none of it reads as
 * text: a string (a title, a hyperlink's address) up to the bell or the
 * string's end, or the line's; a colour or a cursor move, 7-bit or
 * 8-bit; or an ESC and the character it takes.
 */
const ESCAPES = new RegExp(
	[
		`${ESC}[\\]P_^X][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\|$)`,
		`${ESC}\\[[0-?]*[ -/]*[@-~]`,
		"\\u009B[0-?]*[ -/]*[@-~]",
		`${ESC}[ -/]*[0-~]`,
	].join("|"),
	"gu",
);

/** The control characters, a tab among them, each read as a space. */
const CONTROLS = /\p{Cc}/u;

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
	// Ended by our patience, or by a signal nobody here sent (the OOM
	// killer's), its ask may already be with the node, as a sprout's is.
	if (
		ran.timedOut ||
		(ran.code === null &&
			!ran.neverRan &&
			!ran.missing &&
			!ran.noFolder &&
			!ran.stopped)
	) {
		const said = lastLine(ran.stderr);
		return said ? { kind: "unsure", from, said } : { kind: "unsure", from };
	}
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
	const said = lastLine(ran.stderr);
	const why = said ? wroteSaid(said) : `it ended with ${ran.code ?? "no code"}`;
	return { kind: "failed", from, why };
}

/**
 * The last line mycelium wrote with anything left once cleaned (shown),
 * a progress bar's last redraw included, so a line of only marks never
 * hides the reason above it. It's cut to MOST_QUOTED whole characters
 * and ended with "..." where it was cut, so a cut reason never reads as
 * the whole of it, or "" where it wrote none. Lines are read from the
 * end, so only the last few are cleaned however much came before.
 */
function lastLine(stderr: string): string {
	const lines = stderr.split(LINE_ENDS);
	let line = "";
	for (let at = lines.length - 1; at >= 0 && line === ""; at -= 1) {
		line = shown(lines[at] ?? "");
	}
	const characters = Array.from(line);
	return characters.length > MOST_QUOTED
		? `${characters.slice(0, MOST_QUOTED).join("")}...`
		: line;
}

/**
 * A line mycelium wrote as it shows, since what it relays may come from a
 * node or a peer. Its escape sequences (ESCAPES) and every character that
 * draws as nothing, a format one or another the node counts as unseen,
 * are dropped. Each control left reads as a space. Its backticks become
 * plain quotes, so none reads as a command beside the one the words ask
 * to run.
 */
function shown(line: string): string {
	return Array.from(line.replace(ESCAPES, ""))
		.filter((each) => !drawsAsNothing(each))
		.map((each) => (CONTROLS.test(each) ? " " : each))
		.join("")
		.replaceAll("`", "'")
		.trim();
}
