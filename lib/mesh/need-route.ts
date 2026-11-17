/**
 * A need put to what it is about: stub, so the tests can run red.
 */

/** A cell and the words of what it works on. */
export interface Forager {
	readonly address: string;
	readonly words: readonly string[];
}

/** A subject's hub, as the node names it from its own tie counts. */
export interface Hub {
	readonly subject: string;
	readonly hub: string;
	readonly fits: readonly string[];
}

/** Each cell's ties, strongest first. */
export type TieGraph = ReadonlyMap<
	string,
	readonly { readonly other: string; readonly strength: number }[]
>;

/** A need as its asker puts it. */
export interface NeedAsked {
	readonly need: string;
	readonly asker: string;
	readonly words: readonly string[];
	readonly at: number;
}

/** A need with where it went, as the scale run's judge reads it. */
export interface NeedRecord extends NeedAsked {
	readonly path: readonly string[];
	readonly fit: string | null;
	readonly cells: number;
}

/** What a need is routed over. */
export interface Reach {
	readonly foragers: readonly Forager[];
	readonly ties: TieGraph;
	readonly hubs: readonly Hub[];
	readonly live?: (address: string) => boolean;
}

/** The most ties a need passes along before it counts as lost. */
export const MOST_HOPS = 3;

/** Stub. */
export function wordsOf(_text: string): string[] {
	throw new Error("not yet");
}

/** Stub. */
export function foragersFrom(_line: string): Forager[] {
	throw new Error("not yet");
}

/** Stub. */
export function tieGraphFrom(_line: string, _now: number): TieGraph {
	throw new Error("not yet");
}

/** Stub. */
export function hubsFrom(_line: string): Hub[] {
	throw new Error("not yet");
}

/** Stub. */
export function routeNeed(_asked: NeedAsked, _reach: Reach): NeedRecord {
	throw new Error("not yet");
}

/** Stub. */
export function needsFile(_dir: string, _at: number): string {
	throw new Error("not yet");
}

/** Stub. */
export function keepNeed(_dir: string, _record: NeedRecord): Promise<void> {
	throw new Error("not yet");
}

/** Stub. */
export function needAt(
	_socket: string | undefined,
	_asked: NeedAsked,
	_how: { live: (address: string) => boolean; keep: string },
): Promise<NeedRecord | undefined> {
	throw new Error("not yet");
}
