/**
 * Who owns a line Joel says into the void, read from what he had
 * attached and from the quests that claim it.
 *
 * The void sent every line whose owner its words didn't name to the
 * orchestrator, though what he attached often named it: a Delta pull
 * request whose author session was on the mesh, a Quick site a quest
 * holds (Joel, 14 November 2026: "why did the void send that to you?
 * you're not the best destination for a lot of this shit."). So a line
 * is placed by what is attached, in the order the orchestrator set
 * (WCJQSG, 14 November 2026): the file the focused window shows, by
 * the quest folder or scratch folder it sits in (Joel, 14 November
 * 2026: "we need the void to be more aware of what is on a window that
 * i'm focused on when i launch it"); the attached pi session; a pull
 * request's quest alias, then whoever claims the tree its files sit
 * under, then the session that wrote about it on the mesh; a page's
 * address against quests' aliases and READMEs; the
 * window's quest name or repository; then his words against open
 * quests' titles. Each candidate says how it matched, and when none
 * does, what was tried, so the void can pick the one his words are
 * about and the orchestrator can see why a line reached it.
 *
 * A tree is claimed by a `url` alias naming it, such as
 * `delta.shopify.io/shop/world/tree/main/areas/incubating/aquifer`,
 * since a zone's pull requests come and go hourly (WM4KSZ, 14 November
 * 2026); the deepest tree claimed wins.
 */

import { count, verb } from "../ui/count.ts";

/** What Joel had attached to a line, as the line's `Attached:` rows say. */
export interface Attached {
	/** The focused window, as `<program> · <title>`. */
	readonly window?: string;
	/** The Chrome tab's title. */
	readonly tabTitle?: string;
	/** The Chrome tab's address. */
	readonly tabUrl?: string;
	/** The attached pi session's quest title. */
	readonly sessionTitle?: string;
	/** The attached pi session's address. */
	readonly sessionAddress?: string;
	/** The absolute path of the file the focused window shows. */
	readonly file?: string;
}

/** A line split into Joel's words and what he had attached. */
export interface SaidLine {
	readonly words: string;
	readonly attached: Attached;
}

/** What placing a line needs to know of one open quest. */
export interface OpenQuest {
	readonly id: string;
	readonly title: string;
	/** Its short name, which names its session's window. */
	readonly short?: string;
	/** The quest it sits under, whose work a site or page often serves. */
	readonly parent?: string;
	readonly aliases: readonly {
		readonly type: string;
		readonly value: string;
	}[];
	/** Its README's body, where its links are written. */
	readonly body: string;
	/** The repositories and zones its trees hold. */
	readonly repos: readonly string[];
}

/** One place a line could go, and why. */
export interface Candidate {
	readonly address: string;
	readonly title: string;
	readonly how: string;
}

/** Every place a line could go, best first, and what was looked at. */
export interface Placement {
	readonly candidates: readonly Candidate[];
	readonly tried: readonly string[];
}

/** A pull request Joel had attached. */
export interface PullRequest {
	/** Where it is hosted, when its address said. */
	readonly host?: string;
	/** Its repository, as `owner/repo`. */
	readonly repo: string;
	readonly number: string;
}

/** What placing a line reads besides the quests. */
export interface Sources {
	readonly quests: readonly OpenQuest[];
	/** The senders of recent mesh messages whose text holds `needle`. */
	readonly sendersOf: (needles: readonly string[]) => readonly string[];
	/** The paths a pull request touches, or nothing when they can't be read. */
	readonly filesOf?: (pull: PullRequest) => readonly string[] | undefined;
	/** Addresses that only pass lines on: the void and the orchestrator. */
	readonly relays: ReadonlySet<string>;
}

const ATTACHED = /\n\s*Attached:\s*\n/u;
const ROW = /^-\s*(window|tab|pi session|file):\s*(.*)$/u;
const QUEST_FOLDER = /(?:^|-)(QEST-\d{8}-[A-Z0-9]{6})$/u;
const SEPARATOR = " · ";
const PULL = /https?:\/\/([^/\s]+)\/([\w.-]+\/[\w.-]+)\/pulls?\/(\d+)/u;
const TREE =
	/^(?:https?:\/\/)?([^/\s]+)\/([\w.-]+\/[\w.-]+)\/(?:tree|blob)\/[^/\s]+\/(.+?)\/*$/u;
const SCHEME = /^https?:\/\//u;
const FILE_PAGE = "/blob/";
const TREE_PAGE = "/tree/";
const PULL_REF = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/u;
const ADDRESS_CHARS = 6;
const WORD = /[\p{L}\p{N}]+/gu;
const SHORTEST_WORD = 4;
const FEWEST_SHARED_WORDS = 2;
const MOST_BY_WORDS = 3;
const MOST_BY_PAGE = 2;
const PI_WINDOW = /^π\s*-\s*(.+?)(?:…)?\s*-\s*([^-]+)$/u;

/**
 * Words too common in Joel's lines and quest titles to say what a line
 * is about.
 */
const COMMON = new Set([
	"that",
	"this",
	"with",
	"from",
	"they",
	"them",
	"their",
	"what",
	"when",
	"want",
	"need",
	"have",
	"into",
	"like",
	"also",
	"about",
	"should",
	"would",
	"could",
	"there",
	"than",
	"then",
	"make",
	"every",
	"each",
	"more",
	"just",
	"still",
	"being",
	"joel",
	"joel's",
]);

/** Split a line into his words and its `Attached:` rows. */
export function readLine(line: string): SaidLine {
	const [words = "", rows = ""] = line.split(ATTACHED, 2);
	let attached: Attached = {};
	for (const raw of rows.split("\n")) {
		const row = ROW.exec(raw.trim());
		if (!row) continue;
		const [, kind, value = ""] = row;
		const at = value.lastIndexOf(SEPARATOR);
		const head = at < 0 ? value : value.slice(0, at);
		const tail = at < 0 ? "" : value.slice(at + SEPARATOR.length);
		if (kind === "window") attached = { ...attached, window: value };
		if (kind === "file") attached = { ...attached, file: value.trim() };
		if (kind === "tab")
			attached = { ...attached, tabTitle: head, tabUrl: tail };
		if (kind === "pi session")
			attached = { ...attached, sessionTitle: head, sessionAddress: tail };
	}
	return { words: words.trim(), attached };
}

/** The address a quest's session answers to: its id's last six. */
export function questAddress(id: string): string {
	return id.slice(-ADDRESS_CHARS).toUpperCase();
}

/** Every place a line could go, best first, and what was tried. */
export function placeLine(line: string, sources: Sources): Placement {
	const said = readLine(line);
	const found: Candidate[] = [];
	const tried: string[] = [];
	const add = (candidates: readonly Candidate[]): void => {
		for (const candidate of candidates) {
			if (sources.relays.has(candidate.address)) continue;
			if (found.some((f) => f.address === candidate.address)) continue;
			found.push(candidate);
		}
	};
	const steps: readonly ((
		said: SaidLine,
		sources: Sources,
	) => { tried?: string; found: readonly Candidate[] })[] = [
		byFile,
		bySession,
		byPull,
		byPage,
		byWindow,
		byWords,
	];
	for (const step of steps) {
		const outcome = step(said, sources);
		if (outcome.tried) tried.push(outcome.tried);
		add(outcome.found);
	}
	return { candidates: found, tried };
}

/**
 * The quest whose folder, or scratch folder, holds the file the focused
 * window shows: the quest named by the path's last folder that is a
 * quest's id, or ends in one as its temporary folder does.
 */
function byFile(
	said: SaidLine,
	sources: Sources,
): { tried?: string; found: Candidate[] } {
	const { file } = said.attached;
	if (!file) return { found: [] };
	const id = file
		.split("/")
		.map((segment) => QUEST_FOLDER.exec(segment)?.[1])
		.filter((found) => found !== undefined)
		.at(-1);
	if (!id) return { tried: `the file ${file} (in no quest's folder)`, found: [] };
	const quest = sources.quests.find((open) => open.id === id);
	if (!quest)
		return { tried: `the file ${file} (its quest ${id} isn't open)`, found: [] };
	return {
		tried: `the file ${file}`,
		found: [fromQuest(quest, "the file sits in its folder")],
	};
}

function bySession(said: SaidLine): { tried?: string; found: Candidate[] } {
	const { sessionAddress, sessionTitle } = said.attached;
	if (!sessionAddress) return { found: [] };
	return {
		tried: `the attached pi session ${sessionAddress}`,
		found: [
			{
				address: sessionAddress.toUpperCase(),
				title: sessionTitle ?? sessionAddress,
				how: "the attached pi session",
			},
		],
	};
}

function byPull(
	said: SaidLine,
	sources: Sources,
): { tried?: string; found: Candidate[] } {
	const pull = pullOf(said.attached);
	if (!pull) return { found: [] };
	const ref = `${pull.repo}#${pull.number}`;
	const claimed = sources.quests.filter((quest) =>
		quest.aliases.some((alias) => aliasNamesPull(alias.value, pull)),
	);
	if (claimed.length > 0)
		return {
			tried: `the pull request ${ref}`,
			found: claimed.map((quest) =>
				fromQuest(quest, `holds ${ref} as an alias`),
			),
		};
	const files = sources.filesOf?.(pull);
	const zoned = files ? byTree(pull, files, sources.quests) : [];
	const senders = sources
		.sendersOf([ref, `/pull/${pull.number}`])
		.filter((sender) => !sources.relays.has(sender));
	const writer = mostFrequent(senders);
	const quest = sources.quests.find((q) => questAddress(q.id) === writer);
	const wrote: Candidate[] = writer
		? [
				{
					address: writer,
					title: quest?.title ?? writer,
					how: `wrote of ${ref} on the mesh`,
				},
			]
		: [];
	if (zoned.length === 0 && wrote.length === 0)
		return {
			tried: `the pull request ${ref} (${unclaimed(files)}, no session wrote of it)`,
			found: [],
		};
	return { tried: `the pull request ${ref}`, found: [...zoned, ...wrote] };
}

/** The quests claiming a tree the pull request's files sit under, deepest first. */
function byTree(
	pull: PullRequest,
	files: readonly string[],
	quests: readonly OpenQuest[],
): Candidate[] {
	return quests
		.flatMap((quest) =>
			quest.aliases.flatMap((alias) => {
				const tree = treeOf(alias.value);
				if (!tree || tree.repo !== pull.repo) return [];
				if (pull.host && tree.host !== pull.host) return [];
				const under = files.filter((f) => isUnder(f, tree.path)).length;
				return under > 0 ? [{ quest, path: tree.path, under }] : [];
			}),
		)
		.sort((a, b) => b.path.length - a.path.length || b.under - a.under)
		.map(({ quest, path, under }) =>
			fromQuest(
				quest,
				`claims ${path}, where ${under} of its ${count(files.length, "file")} sit`,
			),
		);
}

/** What no quest claimed of a pull request, its files when they were read. */
function unclaimed(files: readonly string[] | undefined): string {
	if (!files) return "no quest alias";
	const sit = verb(files.length, "sits", "sit");
	return `no quest claims it or a tree its ${count(files.length, "file")} ${sit} under`;
}

function treeOf(
	value: string,
): { host: string; repo: string; path: string } | undefined {
	const tree = TREE.exec(value.trim());
	if (!tree) return undefined;
	const [, host = "", repo = "", path = ""] = tree;
	return { host, repo, path };
}

function isUnder(file: string, path: string): boolean {
	return file === path || file.startsWith(`${path}/`);
}

function byPage(
	said: SaidLine,
	sources: Sources,
): { tried?: string; found: Candidate[] } {
	const url = said.attached.tabUrl;
	if (!url || pullOf(said.attached)) return { found: [] };
	const host = hostOf(url);
	if (!host) return { found: [] };
	const site = host.split(".")[0] ?? host;
	const claimed = sources.quests.filter((quest) =>
		quest.aliases.some((alias) => aliasNamesPage(alias, url, host, site)),
	);
	if (claimed.length > 0)
		return {
			tried: `the page ${host}`,
			found: withParents(
				claimed.map((quest) => ({ quest, how: `holds ${host} as an alias` })),
				sources.quests,
			),
		};
	const written = sources.quests
		.map((quest) => ({ quest, times: occurrences(quest.body, host) }))
		.filter((entry) => entry.times > 0)
		.sort((a, b) => b.times - a.times)
		.slice(0, MOST_BY_PAGE);
	return {
		tried:
			written.length > 0
				? `the page ${host}`
				: `the page ${host} (no quest names it)`,
		found: withParents(
			written.map(({ quest, times }) => ({
				quest,
				how: `its README names ${host} ${times === 1 ? "once" : `${times} times`}`,
			})),
			sources.quests,
		),
	};
}

function byWindow(
	said: SaidLine,
	sources: Sources,
): { tried?: string; found: Candidate[] } {
	const title = said.attached.window?.split(SEPARATOR).slice(1).join(SEPARATOR);
	const pi = title ? PI_WINDOW.exec(title.trim()) : null;
	if (!pi) return { found: [] };
	const [, name = "", repo = ""] = pi;
	const wanted = name.trim().toLowerCase();
	const named = sources.quests.filter((quest) =>
		[quest.short, quest.title].some((n) => n?.toLowerCase().startsWith(wanted)),
	);
	if (named.length === 1)
		return {
			tried: `the pi window "${name.trim()}"`,
			found: named.map((quest) => fromQuest(quest, "its session's window")),
		};
	const holding = sources.quests.filter((quest) =>
		quest.repos.includes(repo.trim()),
	);
	if (holding.length === 1)
		return {
			tried: `the window's repository ${repo.trim()}`,
			found: holding.map((quest) =>
				fromQuest(quest, `the one quest in ${repo.trim()}`),
			),
		};
	return {
		tried: `the pi window "${name.trim()}" (${named.length} quests by that name, ${holding.length} in ${repo.trim()})`,
		found: [],
	};
}

function byWords(
	said: SaidLine,
	sources: Sources,
): { tried?: string; found: Candidate[] } {
	const his = new Set(wordsOf(said.words));
	const scored = sources.quests
		.map((quest) => {
			const shared = [...new Set(wordsOf(quest.title))].filter((w) =>
				his.has(w),
			);
			return { quest, shared };
		})
		.filter((entry) => entry.shared.length >= FEWEST_SHARED_WORDS)
		.sort((a, b) => b.shared.length - a.shared.length)
		.slice(0, MOST_BY_WORDS);
	return {
		tried: scored.length > 0 ? "his words" : "his words (no title shares two)",
		found: scored.map(({ quest, shared }) =>
			fromQuest(quest, `its title shares "${shared.join(", ")}"`),
		),
	};
}

function pullOf(attached: Attached): PullRequest | undefined {
	const fromUrl = attached.tabUrl ? PULL.exec(attached.tabUrl) : null;
	if (fromUrl)
		return {
			host: fromUrl[1] ?? "",
			repo: fromUrl[2] ?? "",
			number: fromUrl[3] ?? "",
		};
	const text = `${attached.tabTitle ?? ""} ${attached.window ?? ""}`;
	const fromTitle = PULL_REF.exec(text);
	if (fromTitle)
		return { repo: fromTitle[1] ?? "", number: fromTitle[2] ?? "" };
	return undefined;
}

function aliasNamesPull(value: string, pull: PullRequest): boolean {
	if (value === `${pull.repo}#${pull.number}`) return true;
	const url = PULL.exec(value);
	return url !== null && url[2] === pull.repo && url[3] === pull.number;
}

function aliasNamesPage(
	alias: { type: string; value: string },
	url: string,
	host: string,
	site: string,
): boolean {
	const value = alias.value.replace(/\/+$/u, "");
	if (value === "") return false;
	if (value === host || value === site) return true;
	const claim = bare(value);
	if (!claim.includes("/")) return hostOf(`https://${claim}`) === host;
	const page = bare(url);
	return (
		page === claim ||
		["/", "?", "#"].some((end) => page.startsWith(claim + end))
	);
}

/** An address without its scheme, a file's page read as its tree's. */
function bare(url: string): string {
	return url.replace(SCHEME, "").replace(FILE_PAGE, TREE_PAGE);
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).host;
	} catch {
		// Not an address, such as a bare site name in an alias.
		return undefined;
	}
}

/**
 * Each match, then the quest above the first: a site's quest serves its
 * parent's work, which may be what his words are about.
 */
function withParents(
	matches: readonly { quest: OpenQuest; how: string }[],
	quests: readonly OpenQuest[],
): Candidate[] {
	const found = matches.map(({ quest, how }) => fromQuest(quest, how));
	const first = matches[0]?.quest;
	const parent = first?.parent
		? quests.find((q) => q.id === first.parent)
		: undefined;
	if (first && parent)
		found.splice(
			1,
			0,
			fromQuest(parent, `the quest above ${questAddress(first.id)}`),
		);
	return found;
}

function fromQuest(quest: OpenQuest, how: string): Candidate {
	return { address: questAddress(quest.id), title: quest.title, how };
}

function wordsOf(text: string): string[] {
	return (text.toLowerCase().match(WORD) ?? []).filter(
		(w) => w.length >= SHORTEST_WORD && !COMMON.has(w),
	);
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function mostFrequent(values: readonly string[]): string | undefined {
	const tally = new Map<string, number>();
	for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
	let best: string | undefined;
	for (const [v, n] of tally)
		if (best === undefined || n > (tally.get(best) ?? 0)) best = v;
	return best;
}
