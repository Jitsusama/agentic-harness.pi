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
 * it, and its asker is told to name the peers it is for.
 *
 * Each need is kept as one line in the day's file, in the shape the
 * scale run's judge reads (`judge.py needs`): who asked, its words,
 * every cell it passed after the asker with the fit last, and the
 * realm's size. Its id is the asker's address, a stamp and a count of
 * its own, so no two needs share one and it never changes as it goes.
 * Only words some cell works on are kept when they were read from a
 * message's text, at most `MOST_WORDS` of them, so a token pasted into
 * the text never lands in the file. The files go with the week the
 * mesh keeps its messages (retention.ts).
 *
 * The path is the chain the fit was found along, read from the node's
 * own ties and hubs. Only the fit is written to: the cells on the way
 * are not asked in turn, since the node already holds what each would
 * answer. A fit is chosen by the words of its own title and repository,
 * which the cell sets, so a cell can draw needs by what its title says.
 * That routes a message and grants nothing: a need finds who works on
 * something, and a yes, a ruling or a grant still comes only from the
 * owner named by address.
 */

import { readdirSync, rmSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../internal/record.ts";
import { listAt, TIE_HALF_LIFE_MS } from "./node.ts";

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
	/** `<asker>/<its own stamp>`, the same wherever the need goes. */
	readonly need: string;
	readonly asker: string;
	readonly words: readonly string[];
	/** When it was asked, in milliseconds. */
	readonly at: number;
	/**
	 * Whether its words were read from the message's text rather than
	 * said as what it is about, so only those a cell works on are kept.
	 */
	readonly fromText?: boolean;
}

/** A need with where it went, as the scale run's judge reads it. */
export interface NeedRecord extends NeedAsked {
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
}

/** What a need is routed over. */
export interface Reach {
	readonly foragers: readonly Forager[];
	readonly ties: TieGraph;
	readonly hubs: readonly Hub[];
	/** Whether a cell is there to take or pass a need; every one, unsaid. */
	readonly live?: (address: string) => boolean;
}

/** The most ties a need passes along before it counts as lost. */
export const MOST_HOPS = 3;

/** The most words a need is routed and kept by. */
export const MOST_WORDS = 12;

/** The longest word a need keeps: longer is a token, not a word of work. */
const LONGEST_WORD = 32;

/** Needs minted in this process, so two in one moment differ. */
let minted = 0;

/** A new need's id: its asker's address, then a stamp and count of its own. */
export function needId(asker: string, at: number): string {
	minted += 1;
	return `${asker}/${at.toString(36)}.${minted.toString(36)}`;
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
 * The words a need or a cell's work is matched by: lowercased, once
 * each, leaving out the short and the common.
 */
export function wordsOf(text: string): string[] {
	const words = text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length >= SHORTEST_WORD && !COMMON.has(word));
	return [...new Set(words)];
}

/**
 * The cells in a node's list of its `cell` kind, each with the words of
 * its title and repository; none for an answer that lists no records.
 */
export function foragersFrom(line: string): Forager[] {
	return recordsOf(line).flatMap((record): Forager[] => {
		const { key, title, repo } = record;
		if (typeof key !== "string" || !key.startsWith("cell:")) return [];
		const said = [title, repo].filter((one) => typeof one === "string");
		return [
			{ address: key.slice("cell:".length), words: wordsOf(said.join(" ")) },
		];
	});
}

/**
 * Every cell's ties in a node's list of its `tie` kind, joined at both
 * ends, each faded to `now` by 2^-((now - heard) / 2 h), strongest first.
 * A cell's own talk, `tie:<A>`, names no other end and is left out.
 */
export function tieGraphFrom(line: string, now: number): TieGraph {
	const graph = new Map<string, { other: string; strength: number }[]>();
	const join = (one: string, other: string, strength: number) =>
		graph.set(one, [...(graph.get(one) ?? []), { other, strength }]);
	for (const record of recordsOf(line)) {
		const { key, strength, heard } = record;
		if (typeof key !== "string" || !key.startsWith("tie:")) continue;
		if (typeof strength !== "number" || typeof heard !== "number") continue;
		const [one, other, ...more] = key.slice("tie:".length).split("~");
		if (one === undefined || other === undefined || more.length > 0) continue;
		const faded = strength * 2 ** (-(now - heard) / TIE_HALF_LIFE_MS);
		join(one, other, faded);
		join(other, one, faded);
	}
	for (const ties of graph.values()) {
		ties.sort((a, b) => b.strength - a.strength);
	}
	return graph;
}

/**
 * The hubs in a node's list of its `hub` kind; none for a node that
 * holds no hubs yet, which refuses the kind.
 */
export function hubsFrom(line: string): Hub[] {
	return recordsOf(line).flatMap((record): Hub[] => {
		const { key, hub, fits } = record;
		if (typeof key !== "string" || !key.startsWith("hub:")) return [];
		if (typeof hub !== "string" || !Array.isArray(fits)) return [];
		return [
			{
				subject: key.slice("hub:".length),
				hub,
				fits: fits.filter((fit) => typeof fit === "string"),
			},
		];
	});
}

/**
 * Where a need goes: already held when its asker works on every word;
 * else to its rarest word's narrowest hub naming a fit that is there;
 * else along ties to the nearest cell working on that word, taking of
 * the cells as near the one working on most of the need. Lost, with no
 * path, when none is within `MOST_HOPS`. A cell that works on it but has
 * ended is never taken, and is named in `ended`.
 */
export function routeNeed(said: NeedAsked, reach: Reach): NeedRecord {
	const asked = { ...said, words: keptWords(said, reach.foragers) };
	const passed = new Set<string>();
	const record = (path: readonly string[], fit: string | null): NeedRecord => ({
		need: asked.need,
		asker: asked.asker,
		words: asked.words,
		path,
		fit,
		at: asked.at,
		cells: reach.foragers.length,
		...(passed.size > 0 ? { ended: [...passed] } : {}),
	});
	const live = reach.live ?? (() => true);
	const wordsHeld = new Map(
		reach.foragers.map((cell) => [cell.address, new Set(cell.words)]),
	);
	const holds = (address: string, word: string) =>
		wordsHeld.get(address)?.has(word) ?? false;
	if (
		asked.words.length > 0 &&
		asked.words.every((word) => holds(asked.asker, word))
	) {
		return record([], asked.asker);
	}
	const takes = (address: string) => address !== asked.asker && live(address);
	const holders = (word: string) =>
		reach.foragers.filter(
			(cell) => takes(cell.address) && holds(cell.address, word),
		);
	/** Whether a cell would take it but has ended, noting it when so. */
	const endedHolder = (address: string, word: string) => {
		const gone =
			address !== asked.asker && !live(address) && holds(address, word);
		if (gone) passed.add(address);
		return gone;
	};
	const rarest = [...asked.words]
		.map((word) => ({ word, count: holders(word).length }))
		.filter(({ count }) => count > 0)
		.sort((a, b) => a.count - b.count || a.word.localeCompare(b.word));
	const [first] = rarest;
	if (first === undefined) return record([], null);
	const most = (address: string) =>
		asked.words.filter((word) => holds(address, word)).length;
	const best = (candidates: readonly string[]) =>
		candidates.reduce<string | undefined>(
			(chosen, one) =>
				chosen === undefined || most(one) > most(chosen) ? one : chosen,
			undefined,
		);

	for (const { word } of rarest) {
		for (const hub of hubsFor(word, reach.hubs)) {
			const fit = best(
				hub.fits.filter(
					(one) => !endedHolder(one, word) && takes(one) && holds(one, word),
				),
			);
			if (fit === undefined || !live(hub.hub)) continue;
			return record(hub.hub === fit ? [fit] : [hub.hub, fit], fit);
		}
	}

	const parent = new Map<string, string>();
	let frontier = [asked.asker];
	for (let hop = 1; hop <= MOST_HOPS && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const cell of frontier) {
			for (const { other } of reach.ties.get(cell) ?? []) {
				if (other === asked.asker || parent.has(other)) continue;
				if (endedHolder(other, first.word) || !takes(other)) continue;
				parent.set(other, cell);
				next.push(other);
			}
		}
		const fit = best(next.filter((one) => holds(one, first.word)));
		if (fit !== undefined)
			return record(chainTo(fit, asked.asker, parent), fit);
		frontier = next;
	}
	return record([], null);
}

/**
 * The words a need is routed and kept by: none past `LONGEST_WORD`, at
 * most `MOST_WORDS`, and, read from a text, only those a cell works on.
 */
function keptWords(asked: NeedAsked, foragers: readonly Forager[]): string[] {
	const held = new Set(foragers.flatMap((cell) => cell.words));
	return asked.words
		.filter((word) => word.length <= LONGEST_WORD)
		.filter((word) => !asked.fromText || held.has(word))
		.slice(0, MOST_WORDS);
}

/** The hubs whose subject is `word` or ends in it, narrowest first. */
function hubsFor(word: string, hubs: readonly Hub[]): Hub[] {
	const depth = (hub: Hub) => hub.subject.split(":").length;
	return hubs
		.filter((hub) => hub.subject.split(":").at(-1) === word)
		.sort((a, b) => depth(b) - depth(a));
}

/** The cells from the asker's first tie to `fit`, as the walk found them. */
function chainTo(
	fit: string,
	asker: string,
	parent: ReadonlyMap<string, string>,
): string[] {
	const chain = [fit];
	for (
		let at = parent.get(fit);
		at !== undefined && at !== asker;
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
 * Routes a need over what the node serving `socket` keeps, its cells,
 * ties and hubs, and keeps it in `keep`; nothing, and nothing kept, when
 * no node answers there.
 */
export async function needAt(
	socket: string | undefined,
	asked: NeedAsked,
	how: { readonly live: (address: string) => boolean; readonly keep: string },
): Promise<NeedRecord | undefined> {
	const [cells, ties, hubs] = await Promise.all([
		listAt(socket, "cell", ["title", "repo"], LIST_PATIENCE_MS),
		listAt(socket, "tie", ["strength", "heard"], LIST_PATIENCE_MS),
		listAt(socket, "hub", ["hub", "fits"], LIST_PATIENCE_MS),
	]);
	if (cells === undefined) return undefined;
	const record = routeNeed(asked, {
		foragers: foragersFrom(cells),
		ties: ties === undefined ? new Map() : tieGraphFrom(ties, asked.at),
		hubs: hubs === undefined ? [] : hubsFrom(hubs),
		live: how.live,
	});
	await keepNeed(how.keep, record);
	return record;
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
