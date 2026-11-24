/**
 * A need put to what it is about, rather than to an orchestrator.
 *
 * A session that needs something and doesn't know who holds it used to
 * ask its orchestrator, which made every orchestrator a funnel: on 16
 * November the busiest five cells carried 48% of the mesh's messages.
 * So a need now goes by its words. It is put to its rarest word first,
 * the one the fewest cells work on, since that is what narrows it. Where
 * the node names a hub for that word's subject, the hub names the fit;
 * where it names none (none do before the node's hubs land), the need
 * passes along the node's ties, strongest first, until a cell working on
 * it is reached, at most `MOST_HOPS` away. Nothing falls back to a
 * leader: a need nothing can take is counted lost, so the measure sees
 * it, and its asker is told to name the peers it is for. Nor does it
 * fall back to a broader word when every cell holding its narrowest has
 * ended: that cell owned it, and one sharing only a broader word does
 * not, so the need is lost and its asker told who ended.
 *
 * Each need is kept as one line in the day's file, in the shape the
 * scale run's judge reads (`judge.py needs`): who asked, its words,
 * every cell it passed after the asker with the fit last, and the
 * realm's size. Its id is the asker's address, a stamp and a random
 * tail, so no two needs share one and it never changes as it goes.
 * Only words some cell works on are kept when they were read from a
 * message's text, at most `MOST_WORDS` of them, so a token pasted into
 * the text never lands in the file. The files go with the week the
 * mesh keeps its messages (retention.ts).
 *
 * The path is the chain the fit was found along, read from the node's
 * own ties and hubs. Only the fit is written to: the cells on the way
 * are not asked in turn, since the node already holds what each would
 * answer. A fit is chosen by the words of its own title, its repository
 * and the subjects it declares, which the cell and its forage set, so a
 * cell can draw needs by what it says it works on. A subject counts by
 * its narrowest part alone, after its last colon, dot or slash, a
 * service unit's `.service` left out first: `mycelium:easing` gives
 * `easing`, never `mycelium`, since declaring a narrow subject claims
 * nothing of the broader one, and `unstamped:agents.service` gives
 * `agents`. At most `MOST_SUBJECTS` are read from a cell and
 * `MOST_SUBJECT_WORDS` words taken from them, and a need keeps the
 * words that route it rarest first, so a cell declaring many can't
 * crowd it, nor its asker's own. That routes a message and grants
 * nothing: a need finds who works on something, and a yes, a ruling or
 * a grant still comes only from the owner named by address.
 */

import { createHash, randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../internal/record.ts";
import { listAt, TIE_HALF_LIFE_MS } from "./node.ts";
import { MOST_SUBJECTS } from "./subjects.ts";

/** A cell and the words of what it works on. */
export interface Forager {
	readonly address: string;
	readonly words: readonly string[];
}

/** A subject's hub, as the node names it from its own tie counts. */
export interface Hub {
	/** A word, or one narrowed by colons, such as `mycelium:carry`. */
	readonly subject: string;
	/** The cell the subject's needs are put to. */
	readonly hub: string;
	/** The cells it names as working on the subject, best first. */
	readonly fits: readonly string[];
}

/** Each cell's ties, strongest first. */
export type TieGraph = ReadonlyMap<
	string,
	readonly { readonly other: string; readonly strength: number }[]
>;

/** A need as its asker puts it. */
export interface NeedAsked {
	/** `<asker>/<stamp>.<random tail>`, the same wherever the need goes. */
	readonly need: string;
	readonly asker: string;
	readonly words: readonly string[];
	/** When it was asked, in milliseconds. */
	readonly at: number;
	/**
	 * Whether its words were read from the message's text rather than
	 * said as what it is about, which a refusal says; never kept.
	 */
	readonly fromText?: boolean;
	/**
	 * The asker's other addresses, one peer under each, so none is taken
	 * as the fit and the walk sets out from all of them; never kept.
	 */
	readonly selves?: readonly string[];
}

/** A need with where it went, as the scale run's judge reads it. */
export interface NeedRecord extends Omit<NeedAsked, "fromText" | "selves"> {
	/** Every cell after the asker, the fit last; empty when already held. */
	readonly path: readonly string[];
	/** The cell that works on it, or nothing for a need counted lost. */
	readonly fit: string | null;
	/** How many cells the realm had, so one file can hold every size. */
	readonly cells: number;
	/**
	 * Cells that work on it but were passed over because they have ended,
	 * so the asker is told rather than left to wonder; left out when none.
	 */
	readonly ended?: readonly string[];
	/**
	 * The live cell found for a need counted lost because a cell named in
	 * `ended` worked on more of it, so the asker can still name it; left
	 * out otherwise.
	 */
	readonly fellShort?: string;
	/**
	 * Cells that work on a need counted lost but stopped its asker, so
	 * the asker is told why rather than that no cell works on it; left out
	 * when none, or when the need was found.
	 */
	readonly stopped?: readonly string[];
}

/** What a need is routed over. */
export interface Reach {
	readonly foragers: readonly Forager[];
	readonly ties: TieGraph;
	readonly hubs: readonly Hub[];
	/**
	 * Whether a cell is there to take a need or be found through. Always
	 * said, so a caller that forgets it reaches no cell rather than every
	 * one.
	 */
	readonly live: (address: string) => boolean;
	/**
	 * Whether a cell has stopped the asker. It is never taken and never
	 * named as ended, since it is there: it only won't hear this asker, so
	 * a lost need names it in `stopped`. It may still be found through, as
	 * a hub or along ties, since a need goes to its fit alone. Left out, no
	 * cell has.
	 */
	readonly stopped?: (address: string) => boolean;
}

/** The most ties a need passes along before it counts as lost. */
export const MOST_HOPS = 3;

/** The most words a need is routed and kept by. */
export const MOST_WORDS = 12;

/** The longest word a need keeps: longer is a token, not a word of work. */
const LONGEST_WORD = 32;

/**
 * Random bytes in a need's id, so two in one moment differ without a
 * count kept process-wide, which a host's conversations would share.
 */
const ID_TAIL_BYTES = 6;

/** A new need's id: its asker's address, then a stamp and a random tail. */
export function needId(asker: string, at: number): string {
	const tail = randomBytes(ID_TAIL_BYTES).toString("hex");
	return `${asker}/${at.toString(36)}.${tail}`;
}

/** How long the node has to list a kind: a realm's every cell or tie. */
const LIST_PATIENCE_MS = 2000;

/** Words too short to tell one cell's work from another's. */
const SHORTEST_WORD = 3;

/** Words every title has, which tell nothing about the work. */
const COMMON = new Set([
	"a",
	"all",
	"and",
	"any",
	"are",
	"but",
	"for",
	"from",
	"has",
	"have",
	"how",
	"its",
	"not",
	"now",
	"one",
	"our",
	"out",
	"the",
	"them",
	"then",
	"this",
	"that",
	"what",
	"when",
	"with",
	"without",
	"your",
]);

/**
 * An id written as letters or digits joined by hyphens or underscores,
 * as Aquifer's spec writes what a cell holds as its resident need: a
 * spirit property (I-5, XIII-2), a leg (leg-26), a seam's folder
 * (node_kubelet_cri) or a zone (cert-request), IKQ63G's forms of 21
 * November. Split into words, I-5 gives none and a seam gives words
 * half the realm holds, so each is also kept whole. One starts only
 * where a run of letters or digits does, so a long run with no hyphen
 * is tried once, not from each of its letters.
 */
const JOINED_ID = /(?<![\p{L}\p{N}])[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+/gu;

/**
 * A word and the number after it in prose, "leg 26" or "postgres 15",
 * which is the id leg-26 or postgres-15: split into words the number is
 * lost, being short, or said apart from anything it may belong to. Not
 * a word already inside a joined id, whose number would join the id's
 * last part alone.
 */
const NUMBER_IN_PROSE =
	/(?<![\p{L}\p{N}_-])(\p{L}[\p{L}\p{N}]*)\s+(\p{N}+)(?![\p{L}\p{N}])/gu;

/**
 * The words a need or a cell's work is matched by: lowercased, once
 * each, leaving out the short and the common, then each joined id whole
 * (`JOINED_ID`) no longer than `LONGEST_WORD`, which no route keeps
 * past, and each word with a number after it as their id
 * (`NUMBER_IN_PROSE`).
 */
export function wordsOf(text: string): string[] {
	const lower = text.toLowerCase();
	const words = lower
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length >= SHORTEST_WORD && !COMMON.has(word));
	const ids = [...lower.matchAll(JOINED_ID)]
		.map(([id]) => id)
		.filter((id) => id.length <= LONGEST_WORD);
	const numbered = [...lower.matchAll(NUMBER_IN_PROSE)]
		.map(([, word, n]) => `${word}-${n}`)
		.filter((id) => id.length <= LONGEST_WORD);
	return [...new Set([...words, ...ids, ...numbered])];
}

/** What a cell says it works on, as the node lists each one. */
const CELL_FIELDS = ["title", "repo", "subjects"];

/**
 * What a subject's hub record names: its one hub and fits, or several
 * listed under `hubs`. The node leaves out a field a record lacks.
 * The one hub and fits are still asked for because a record may hold
 * only those, as a node from before `hubs` writes it; where a record
 * holds a readable list as well, the list is read in their place.
 */
const HUB_FIELDS = ["hub", "fits", "hubs"];

/**
 * The most words one cell's declared subjects give it, all together,
 * and apart from them the most joined ids, so an id a subject's words
 * already route never pushes a later subject's words out.
 */
export const MOST_SUBJECT_WORDS = 12;

/**
 * What a declared subject breaks at: colons and dots, as keys do, and
 * slashes, as a repository's scope does.
 */
const SUBJECT_BREAK = /[:./]/;

/**
 * The `.service` ending a subject that names a service unit whole, as
 * owner prefixes such as `unstamped:agents.service` do, read only after
 * a name and never as a part of its own. It says what kind of unit the
 * subject names, never what it works on. Only the service type is read
 * so, since it is the only one owner prefixes name, and the other types'
 * words (`scope`, `target`, `path`) are as often a subject itself. A
 * subject ending in a break, as `health.service.` does, names a
 * namespace rather than a unit, so its `service` is its subject. Read in
 * any case, since the node lowercases a hub's subject and a cell's
 * subjects come as declared.
 */
const SERVICE_UNIT = /(?<=[^:./])\.service$/i;

/** A subject's parts, broadest first, leaving out a service unit's type. */
function subjectParts(subject: string): string[] {
	return subject
		.replace(SERVICE_UNIT, "")
		.split(SUBJECT_BREAK)
		.filter((part) => part !== "");
}

/**
 * The words of a subject's narrowest part, the one after its last colon,
 * dot or slash: `mycelium:easing` gives `easing`, `health.asks.` gives
 * `asks`, and `unstamped:agents.service` gives `agents`, since a
 * service unit's type is left out. A narrowest part with no word long
 * enough gives none, rather than a broader part's.
 */
export function subjectWords(subject: string): string[] {
	return wordsOf(subjectParts(subject).at(-1) ?? "");
}

/**
 * The cells in a node's list of its `cell` kind, each with the words of
 * its title, repository and declared subjects; none for an answer that
 * lists no records. A node that doesn't know subjects yet lists none.
 */
export function foragersFrom(line: string): Forager[] {
	return recordsOf(line).flatMap((record): Forager[] => {
		const { key, title, repo, subjects } = record;
		if (typeof key !== "string" || !key.startsWith("cell:")) return [];
		const declared = firstSubjects(subjects);
		const said = [title, repo].filter((one) => typeof one === "string");
		const titled = wordsOf(said.join(" "));
		return [
			{
				address: key.slice("cell:".length),
				words: [...titled, ...wordsBeyond(titled, declared)],
			},
		];
	});
}

/**
 * The first `MOST_SUBJECTS` strings a record's `subjects` declares,
 * reading no further; none when it isn't a list.
 */
function firstSubjects(subjects: unknown): string[] {
	const first: string[] = [];
	if (!Array.isArray(subjects)) return first;
	for (const one of subjects) {
		if (typeof one !== "string") continue;
		first.push(one);
		if (first.length === MOST_SUBJECTS) break;
	}
	return first;
}

/**
 * The words `subjects` give beyond those `titled` already says, in the
 * order declared, stopping at `MOST_SUBJECT_WORDS`, so a record past the
 * caps is read no further than they reach.
 */
function wordsBeyond(
	titled: readonly string[],
	subjects: readonly string[],
): string[] {
	const seen = new Set(titled);
	const beyond: string[] = [];
	const taken = { words: 0, ids: 0 };
	for (const subject of subjects) {
		for (const word of subjectWords(subject)) {
			const kind = isJoined(word) ? "ids" : "words";
			if (seen.has(word) || taken[kind] === MOST_SUBJECT_WORDS) continue;
			seen.add(word);
			beyond.push(word);
			taken[kind]++;
			if (taken.words + taken.ids === 2 * MOST_SUBJECT_WORDS) return beyond;
		}
	}
	return beyond;
}

/**
 * Every cell's ties in a node's list of its `tie` kind, joined at both
 * ends, each faded to `now` by 2^-((now - heard) / 2 h), strongest first.
 * A cell's own talk, `tie:<A>`, names no other end and is left out.
 */
export function tieGraphFrom(line: string, now: number): TieGraph {
	const graph = new Map<string, { other: string; strength: number }[]>();
	const tieTo = (one: string, other: string, strength: number) => {
		const ties = graph.get(one);
		if (ties === undefined) graph.set(one, [{ other, strength }]);
		else ties.push({ other, strength });
	};
	for (const record of recordsOf(line)) {
		const { key, strength, heard } = record;
		if (typeof key !== "string" || !key.startsWith("tie:")) continue;
		if (typeof strength !== "number" || typeof heard !== "number") continue;
		const [one, other, ...more] = key.slice("tie:".length).split("~");
		if (one === undefined || other === undefined || more.length > 0) continue;
		const faded = strength * 2 ** (-(now - heard) / TIE_HALF_LIFE_MS);
		tieTo(one, other, faded);
		tieTo(other, one, faded);
	}
	for (const ties of graph.values()) {
		ties.sort((a, b) => b.strength - a.strength);
	}
	return graph;
}

/**
 * The hubs in a node's list of its `hub` kind; none for a node that
 * holds no hubs yet, which refuses the kind. A subject's record names
 * one hub and its fits, or lists several under `hubs`, since a record's
 * key is its subject and a subject may have more than one hub. A list
 * naming none it can read leaves the single hub standing.
 */
export function hubsFrom(line: string): Hub[] {
	return recordsOf(line).flatMap((record): Hub[] => {
		const { key, hubs } = record;
		if (typeof key !== "string" || !key.startsWith("hub:")) return [];
		const subject = key.slice("hub:".length);
		const listed = (Array.isArray(hubs) ? hubs.filter(isRecord) : []).flatMap(
			(one) => hubOf(subject, one),
		);
		return listed.length > 0 ? listed : hubOf(subject, record);
	});
}

/** The hub a record or one of its listed hubs names, if it names one. */
function hubOf(subject: string, named: Record<string, unknown>): Hub[] {
	const { hub, fits } = named;
	if (typeof hub !== "string" || !Array.isArray(fits)) return [];
	return [
		{ subject, hub, fits: fits.filter((fit) => typeof fit === "string") },
	];
}

/**
 * Where a need goes: already held when its asker works on every word;
 * else to the cell found for one of the words it doesn't work on that
 * works on most of the need, found through a word's narrowest hub naming
 * a fit that is there or along ties to the nearest cell working on it.
 * Among cells working on as many, a hub's find before any walk's, and
 * among those the rarest word's, rarest counting ended holders too.
 * Taken by its rarest word alone, 15 of 84 needs kept on 23 and 24
 * November, replayed over the node's cells of the 24th, went to cells on
 * "checks" or "gate" sharing no other word.
 *
 * Lost, with no path, when none is within `MOST_HOPS`, or when a cell
 * that has ended worked on more of it than the fit found, which is then
 * named in `fellShort`: that cell owned it, and the fit shares less. Only
 * a cell the node still lists counts, and the node drops a cell whose
 * session ended cleanly, so an owner gone that way is never seen; one
 * whose record lingers is, for as long as it does, but only against a
 * fit sharing less of the need. A live owner beyond `MOST_HOPS` is not
 * seen either, so the need goes to the fit found.
 *
 * A cell that works on it but has ended is never taken, and is named in
 * `ended`: for a found need, when passed over for the word its fit was
 * found by; for a lost one, every such cell, or the owners alone when an
 * owner made it lost. One that stopped the asker is named in `stopped`
 * when the need is lost. Only a cell `live` says is there is taken.
 */
export function routeNeed(said: NeedAsked, reach: Reach): NeedRecord {
	const selves = new Set([said.asker, ...(said.selves ?? [])]);
	const { live } = reach;
	const stopper = reach.stopped ?? (() => false);
	const stops = (address: string) => !selves.has(address) && stopper(address);
	const takes = (address: string) =>
		!selves.has(address) && live(address) && !stops(address);
	const ended = (address: string) =>
		!selves.has(address) && !live(address) && !stops(address);
	// A need goes to its fit alone, so a cell it is found through never
	// hears it: one that stopped the asker may still be walked through.
	const through = (address: string) => !selves.has(address) && live(address);
	const asked = {
		...said,
		words: keptWords(said, reach.foragers, {
			standing: (address) => takes(address) || ended(address),
			self: (address) => selves.has(address),
		}),
	};
	// By the word each was passed over for: every word's finds are looked
	// at before one is taken, and a found need names only the cells passed
	// over for the word its fit was found by.
	const passed = new Map<string, Set<string>>();
	const refusing = new Set<string>();
	const everyPassed = () =>
		new Set([...passed.values()].flatMap((one) => [...one]));
	const record = (
		path: readonly string[],
		fit: string | null,
		named: ReadonlySet<string> = everyPassed(),
	): NeedRecord => ({
		need: asked.need,
		asker: asked.asker,
		words: asked.words,
		path,
		fit,
		at: asked.at,
		cells: reach.foragers.length,
		...(named.size > 0 ? { ended: [...named] } : {}),
		...(refusing.size > 0 ? { stopped: [...refusing] } : {}),
	});
	const wordsHeld = new Map(
		reach.foragers.map((cell) => [cell.address, new Set(cell.words)]),
	);
	const holds = (address: string, word: string) =>
		wordsHeld.get(address)?.has(word) ?? false;
	const ownWord = (word: string) =>
		[...selves].some((self) => holds(self, word));
	if (asked.words.length > 0 && asked.words.every(ownWord)) {
		return record([], asked.asker);
	}
	const holders = (word: string) =>
		reach.foragers.filter(
			(cell) => takes(cell.address) && holds(cell.address, word),
		);
	/** Whether a cell would take it but has ended, noting it when so. */
	const endedHolder = (address: string, word: string) => {
		const gone = ended(address) && holds(address, word);
		if (gone) passed.set(word, (passed.get(word) ?? new Set()).add(address));
		return gone;
	};
	// Narrowest by every cell that holds it, ended ones too, so a word
	// many ended cells held never goes before one a single live cell
	// does; then by those there to take it; then by the word.
	const everyHolder = (word: string) =>
		reach.foragers.filter(
			({ address }) =>
				(takes(address) || ended(address)) && holds(address, word),
		).length;
	const rarest = asked.words
		.filter((word) => !ownWord(word))
		.map((word) => ({
			word,
			count: holders(word).length,
			all: everyHolder(word),
		}))
		.sort(
			(a, b) =>
				a.all - b.all || a.count - b.count || a.word.localeCompare(b.word),
		);
	/** Lost, naming every cell that works on it but has ended or stopped it. */
	const lost = () => {
		for (const { word } of rarest) {
			for (const { address } of reach.foragers) {
				endedHolder(address, word);
				if (stops(address) && holds(address, word)) refusing.add(address);
			}
		}
		return record([], null);
	};
	const within = rarest.filter(({ count }) => count > 0);
	if (within.length === 0) return lost();
	const most = (address: string) =>
		asked.words.filter((word) => holds(address, word)).length;
	const best = (candidates: readonly string[]) =>
		candidates.reduce<string | undefined>(
			(chosen, one) =>
				chosen === undefined || most(one) > most(chosen) ? one : chosen,
			undefined,
		);

	const saying = new Set(said.words);
	// A need naming one numbered id, leg 27, says nothing of another,
	// leg-26, whose words it shares: a cell holding leg-26 takes it on
	// the word leg only when the need says leg-26 as well.
	const numberedParts = new Set(
		said.words.filter(isNumbered).flatMap((id) => id.split(/[-_]/u)),
	);
	const holdsOtherNumber = (address: string, word: string) =>
		numberedParts.has(word) &&
		[...(wordsHeld.get(address) ?? [])].some(
			(held) =>
				isNumbered(held) &&
				held.split(/[-_]/u).includes(word) &&
				!saysWord(held, saying),
		);
	const fitsOn = (address: string, word: string) =>
		takes(address) && holds(address, word) && !holdsOtherNumber(address, word);
	const finds: {
		readonly word: string;
		readonly path: string[];
		readonly fit: string;
	}[] = [];
	for (const { word } of within) {
		// Among hubs that rank the same, the one whose fit works on most of
		// the need; among those, the first the lot drew.
		let chosen: { ranked: RankedHub; fit: string } | undefined;
		for (const ranked of hubsFor(word, saying, reach.hubs, asked.need)) {
			if (chosen !== undefined && !rankSame(chosen.ranked, ranked)) break;
			const { hub } = ranked;
			if (!live(hub.hub)) continue;
			const fit = best(
				hub.fits.filter((one) => !endedHolder(one, word) && fitsOn(one, word)),
			);
			if (fit === undefined) continue;
			if (chosen === undefined || most(fit) > most(chosen.fit)) {
				chosen = { ranked, fit };
			}
		}
		if (chosen !== undefined) {
			const { ranked, fit } = chosen;
			const direct = ranked.hub.hub === fit || selves.has(ranked.hub.hub);
			finds.push({ word, path: direct ? [fit] : [ranked.hub.hub, fit], fit });
		}
	}
	for (const { word } of within) {
		const path = walkTo(word);
		const fit = path?.at(-1);
		if (path !== undefined && fit !== undefined)
			finds.push({ word, path, fit });
	}
	// Hubs' finds first, then walks', each rarest word first, so of fits
	// working on as much of the need the first found wins, as before.
	const found = finds.reduce<(typeof finds)[number] | undefined>(
		(chosen, one) =>
			chosen === undefined || most(one.fit) > most(chosen.fit) ? one : chosen,
		undefined,
	);
	if (found === undefined) return lost();
	// An ended cell that worked on more of it than the fit found was the
	// need's owner: sending it to a cell sharing less of it is a misroute.
	const reached = most(found.fit);
	const owners = reach.foragers
		.map(({ address }) => address)
		.filter((address) => ended(address) && most(address) > reached);
	if (owners.length > 0) {
		return { ...record([], null, new Set(owners)), fellShort: found.fit };
	}
	return record(found.path, found.fit, passed.get(found.word) ?? new Set());

	/**
	 * The chain along ties, strongest first, from the asker to the
	 * nearest live cell working on `word`, or nothing within reach.
	 */
	function walkTo(word: string): string[] | undefined {
		const parent = new Map<string, string>();
		let frontier = [...selves];
		for (let hop = 1; hop <= MOST_HOPS && frontier.length > 0; hop++) {
			const next: string[] = [];
			for (const cell of frontier) {
				for (const { other } of reach.ties.get(cell) ?? []) {
					if (selves.has(other) || parent.has(other)) continue;
					if (endedHolder(other, word) || !through(other)) continue;
					parent.set(other, cell);
					next.push(other);
				}
			}
			const fit = best(next.filter((one) => fitsOn(one, word)));
			if (fit !== undefined) return chainTo(fit, selves, parent);
			frontier = next;
		}
		return undefined;
	}
}

/**
 * The words a need is routed and kept by: only those some cell works
 * on, none past `LONGEST_WORD` and at most `MOST_WORDS`, so a token in
 * what was said, in its text or its `about`, never reaches the file.
 * Past `MOST_WORDS`, those that route it or name its ended owner are
 * kept rarest first, counted over the cells there to take it or ended;
 * then those only cells that stopped the asker hold, which say why the
 * need is lost; then those the asker holds, which route nowhere; among
 * words as rare, the first said. They stay in the order said.
 */
function keptWords(
	asked: NeedAsked,
	foragers: readonly Forager[],
	cells: {
		readonly standing: (address: string) => boolean;
		readonly self: (address: string) => boolean;
	},
): string[] {
	const takers = new Map<string, number>();
	const ownHold = new Set<string>();
	for (const { address, words } of foragers) {
		const taking = cells.standing(address) ? 1 : 0;
		const own = cells.self(address);
		for (const word of words) {
			takers.set(word, (takers.get(word) ?? 0) + taking);
			if (own) ownHold.add(word);
		}
	}
	const held = asked.words.filter(
		(word) => word.length <= LONGEST_WORD && takers.has(word),
	);
	if (held.length <= MOST_WORDS) return held;
	const rarity = (word: string) => {
		if (ownHold.has(word)) return Number.POSITIVE_INFINITY;
		const count = takers.get(word) ?? 0;
		// A cell not the asker's takes it, has ended or stopped the asker,
		// so a held word none of the first two hold is a stopper's alone.
		return count > 0 ? count : UNTAKEN_ONLY;
	};
	const rarest = new Set(
		[...held].sort((a, b) => rarity(a) - rarity(b)).slice(0, MOST_WORDS),
	);
	return held.filter((word) => rarest.has(word));
}

/**
 * How rare a word held only by cells that stopped the asker ranks: past
 * every word a cell there or ended holds, and before those the asker
 * holds.
 */
const UNTAKEN_ONLY = Number.MAX_SAFE_INTEGER;

/**
 * The hubs whose subject's narrowest part says `word`, and says nothing
 * the need didn't, so a hub of `pallet-lines` is never a need's that
 * says lines alone. Those saying more of the need come first, since a
 * need saying easing and lines is narrower than easing alone; then the
 * deepest subject, by its parts, since each part narrows it. Hubs that
 * rank the same are shared out among needs by `need`, one need id
 * always to the same hub, never by the order the node listed them: a
 * node names a hub for every ten holders of a subject, and taking the
 * first listed sent every one of its needs to that hub's fits (the
 * scale run of 18 November: one fit took 34 of 1,000 needs at 10,000
 * cells). A subject's length never ranks.
 */
function hubsFor(
	word: string,
	saying: ReadonlySet<string>,
	hubs: readonly Hub[],
	need: string,
): RankedHub[] {
	const lot = (hub: Hub) =>
		createHash("sha256")
			.update(`${need}\u0000${hub.subject}\u0000${hub.hub}`)
			.digest("hex");
	const ranked = hubs.flatMap((hub) => {
		const words = subjectWords(hub.subject);
		if (!words.includes(word)) return [];
		if (!words.every((one) => saysWord(one, saying))) return [];
		// Said whole or inside a longer id, so leg-26-follow-up says more of
		// leg-26's hub than of a hub for leg alone; said part by part, no
		// more than its parts, so host says pi-host no more than host.
		const says = words.filter(
			(one) => saying.has(one) || saidInside(one, saying),
		).length;
		const depth = subjectParts(hub.subject).length;
		return [{ hub, says, depth, lot: lot(hub) }];
	});
	return ranked.sort(
		(a, b) => b.says - a.says || b.depth - a.depth || byLot(a.lot, b.lot),
	);
}

/**
 * Whether a need `saying` these words says `word` of a subject: said
 * whole, or, for a joined id, said part by part, so `easing lines`
 * says easing-lines and `host` says pi-host, whose pi is too short to
 * be a word; or inside a longer id said, so leg-26-follow-up says
 * leg-26. An id with a part all digits is said only whole or inside
 * another, since its number said apart may belong to anything, so
 * neither `leg 27` nor `leg 27 in 100 runs` says leg-26 or leg-100.
 */
function saysWord(word: string, saying: ReadonlySet<string>): boolean {
	if (saying.has(word)) return true;
	if (!isJoined(word)) return false;
	if (saidInside(word, saying)) return true;
	if (isNumbered(word)) return false;
	const needed = word
		.split(/[-_]/u)
		.filter((part) => part.length >= SHORTEST_WORD && !COMMON.has(part));
	return needed.length > 0 && needed.every((part) => saying.has(part));
}

/** Whether joined id `word` is said inside a longer id the need says. */
function saidInside(word: string, saying: ReadonlySet<string>): boolean {
	if (!isJoined(word)) return false;
	const inside = bounded(word);
	for (const said of saying) {
		if (said !== word && isJoined(said) && bounded(said).includes(inside))
			return true;
	}
	return false;
}

/** Whether `word` is a joined id with a part all digits, as leg-26 is. */
function isNumbered(word: string): boolean {
	return (
		isJoined(word) && word.split(/[-_]/u).some((part) => /^\p{N}+$/u.test(part))
	);
}

/** Whether `word` is a joined id rather than a plain word. */
function isJoined(word: string): boolean {
	return /[-_]/u.test(word);
}

/** `id` with its joins alike and a hyphen at each end, to find it inside another. */
function bounded(id: string): string {
	return `-${id.replaceAll("_", "-")}-`;
}

/** A hub a need may be put to, with what ranks it. */
interface RankedHub {
	readonly hub: Hub;
	/** How many words of the need its subject's narrowest part says. */
	readonly says: number;
	/** How many parts its subject has. */
	readonly depth: number;
	/** The need's draw among hubs that rank the same. */
	readonly lot: string;
}

/** Whether two hubs say as much of a need and are as deep. */
function rankSame(a: RankedHub, b: RankedHub): boolean {
	return a.says === b.says && a.depth === b.depth;
}

/** Two draws in byte order, the same on every machine. */
function byLot(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/** The cells from the asker's first tie to `fit`, as the walk found them. */
function chainTo(
	fit: string,
	selves: ReadonlySet<string>,
	parent: ReadonlyMap<string, string>,
): string[] {
	const chain = [fit];
	for (
		let at = parent.get(fit);
		at !== undefined && !selves.has(at);
		at = parent.get(at)
	) {
		chain.unshift(at);
	}
	return chain;
}

/**
 * Lets go of the needs files in `dir` whose whole UTC day ended before
 * `before`, leaving anything else in the folder.
 */
export function forgetNeeds(dir: string, before: number): void {
	const folder = join(dir, "needs");
	let files: string[];
	try {
		files = readdirSync(folder);
	} catch {
		// No needs kept yet: nothing to let go of.
		return;
	}
	for (const file of files) {
		const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)?.[1];
		if (day === undefined) continue;
		if (Date.parse(`${day}T00:00:00Z`) + DAY_MS <= before) {
			rmSync(join(folder, file), { force: true });
		}
	}
}

/** A UTC day, which a needs file holds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The day's needs file in `dir`, by the UTC day of `at`. */
export function needsFile(dir: string, at: number): string {
	return join(dir, "needs", `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
}

/**
 * Adds a need to its day's file, one line each. A line is far under
 * what one append writes whole, so sessions keeping needs at once never
 * interleave.
 */
export async function keepNeed(dir: string, record: NeedRecord): Promise<void> {
	const file = needsFile(dir, record.at);
	await mkdir(join(dir, "needs"), { recursive: true });
	await appendFile(file, `${JSON.stringify(record)}\n`);
}

/**
 * How long a need asked again, by the same asker in the same words and
 * routed to the same fit, counts as the one already kept: a send refused
 * for how it was worded, or for anything else, is most often sent again
 * within minutes, reworded as the refusal asks, and the ask is still one.
 * So another text on the same subject from the same asker within it is
 * counted as that one too: by its words alone it can't be told from a
 * reworded resend, and keeping the text, or a digest of it, would keep
 * what a need file is meant to leave out. The words are what `about`
 * gives, so this holds for a need sent with one; a need without it is
 * matched on its text's words, and a rewording that changes them counts
 * as a second ask.
 */
export const NEED_AGAIN_MS = 10 * 60 * 1000;

/**
 * Routes a need over what the node serving `socket` keeps, its cells,
 * ties and hubs, and keeps it in `keep`, found or lost, once an ask
 * (`keepNeedOnce`). Nothing, and nothing kept, when
 * no node lists its cells and ties there, since a need routed over half
 * of them would read as lost when it was never looked for. Who stopped
 * the asker is always said here, since it alone keeps such a cell from
 * being taken: `live` names it too, as one a need may be found through.
 * A record the folder won't take is left unkept rather than refusing the send: the
 * measure misses one line, and the asker still reaches its cell.
 */
export async function needAt(
	socket: string | undefined,
	asked: NeedAsked,
	how: Required<Pick<Reach, "live" | "stopped">> & { readonly keep: string },
): Promise<NeedRecord | undefined> {
	const [cells, ties, hubs] = await Promise.all([
		listAt(socket, "cell", CELL_FIELDS, LIST_PATIENCE_MS),
		listAt(socket, "tie", ["strength", "heard"], LIST_PATIENCE_MS),
		listAt(socket, "hub", HUB_FIELDS, LIST_PATIENCE_MS),
	]);
	if (!lists(cells) || !lists(ties)) return undefined;
	const record = routeNeed(asked, {
		foragers: foragersFrom(cells),
		ties: tieGraphFrom(ties, asked.at),
		hubs: hubs === undefined ? [] : hubsFrom(hubs),
		live: how.live,
		stopped: how.stopped,
	});
	await keepNeedOnce(how.keep, record).catch(() => {
		// A full or unwritable folder costs the measure this one line;
		// the send it routes still goes, as the doc above says.
	});
	return record;
}

/**
 * Keeps a need as `keepNeed` does, unless its day's file holds one from
 * the same asker, in the same words and routed to the same fit, asked
 * within `NEED_AGAIN_MS` before it: that is the same ask sent again, so
 * neither found nor lost counts it twice. Kept on the file rather than
 * in memory, so a reload between the two changes nothing; the day before's
 * file is read too when the window reaches back past UTC midnight. A need
 * with no words any cell works on is kept each time, since nothing tells
 * one such ask from another. Two sends of one ask at the same moment may
 * both be kept, since the read and the append aren't one step: that costs
 * the measure a line.
 */
export async function keepNeedOnce(
	dir: string,
	record: NeedRecord,
): Promise<void> {
	const files = new Set([
		needsFile(dir, record.at - NEED_AGAIN_MS),
		needsFile(dir, record.at),
	]);
	for (const file of files) {
		if (await keptAlready(file, record)) return;
	}
	await keepNeed(dir, record);
}

/** Whether `file` holds `record`'s ask, kept within `NEED_AGAIN_MS`. */
async function keptAlready(file: string, record: NeedRecord): Promise<boolean> {
	let lines: string[];
	try {
		lines = (await readFile(file, "utf8")).split("\n");
	} catch {
		// No file yet for the day: nothing kept to match.
		return false;
	}
	if (record.words.length === 0) return false;
	const words = record.words.join(" ");
	return lines.some((line) => {
		const kept = keptLine(line);
		return (
			kept !== undefined &&
			kept.asker === record.asker &&
			kept.fit === record.fit &&
			kept.words.join(" ") === words &&
			record.at - kept.at >= 0 &&
			record.at - kept.at < NEED_AGAIN_MS
		);
	});
}

/** A kept line's ask, or nothing for a line this reader can't use. */
function keptLine(
	line: string,
): Pick<NeedRecord, "asker" | "fit" | "words" | "at"> | undefined {
	if (line.trim() === "") return undefined;
	try {
		const kept: unknown = JSON.parse(line);
		if (!isRecord(kept)) return undefined;
		const { asker, fit, words, at } = kept;
		if (typeof asker !== "string" || typeof at !== "number") return undefined;
		if (fit !== null && typeof fit !== "string") return undefined;
		if (!Array.isArray(words)) return undefined;
		return { asker, fit, at, words: words.map(String) };
	} catch {
		// A torn or foreign line matches no ask.
		return undefined;
	}
}

/** Whether a node answered a list with its records, if none. */
function lists(line: string | undefined): line is string {
	if (line === undefined) return false;
	try {
		const answer: unknown = JSON.parse(line);
		return isRecord(answer) && Array.isArray(answer.records);
	} catch {
		// Not an answer this reader knows: it listed nothing.
		return false;
	}
}

/** The records a node's list answers with, or none. */
function recordsOf(line: string): Record<string, unknown>[] {
	let answer: unknown;
	try {
		answer = JSON.parse(line);
	} catch {
		// Not a list this reader knows: it lists nothing.
		return [];
	}
	if (!isRecord(answer) || !Array.isArray(answer.records)) return [];
	return answer.records.filter(isRecord);
}
