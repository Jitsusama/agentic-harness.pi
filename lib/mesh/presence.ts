/**
 * Presence: what a peer publishes about itself, so others can tell who
 * is on the mesh and what bears on whom.
 *
 * A peer's work is written down in the quest it has loaded: the
 * README's title and the opening of its summary say what the work is,
 * and its trees say which repositories it owns. A peer on no quest is
 * known by where it runs, unless that is the home directory, which says
 * nothing about anything. Presence is kept by session id, which
 * survives a reload and a restore, so a peer stays in the groups it
 * joined.
 *
 * A presence also says which process holds it, so whether the peer is
 * still there is asked of the machine rather than of a clock: a peer
 * whose process has ended is gone, however recently it wrote.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isOwner } from "../core/process/index.ts";
import { keepTicks, type TickedOwner } from "../internal/process-ticks.ts";
import { parseQuestFrontMatter } from "../internal/quest/frontmatter.ts";
import {
	type Orchestration,
	orchestrationOf,
} from "../internal/quest/orchestration.ts";
import type { QuestFrontMatter } from "../quest/types.ts";
import { loadedQuest, type QuestRecords } from "./address.ts";
import { scopesOf } from "./scope.ts";
import { type Stop, stopsFrom } from "./stop.ts";
import { removeQuietly, removeStaged } from "./transport.ts";
import { type Want, wantFrom } from "./want.ts";

/** Every state a presence may say. */
export const PEER_STATES = ["listening", "busy", "waiting", "paused"] as const;

/** What a peer is doing, as its presence says. */
export type PeerState = (typeof PEER_STATES)[number];

function isPeerState(value: unknown): value is PeerState {
	return (PEER_STATES as readonly unknown[]).includes(value);
}

/** One peer, as it is seen on the mesh. */
export interface Presence {
	/** The pi session id, which outlives the process. */
	readonly session: string;
	/** The addresses it answers to, the one it signs with first. */
	readonly addresses: readonly string[];
	/**
	 * Every group it is in, canonical (see group.ts): those its work puts
	 * it in (see scope.ts) and those it joined.
	 */
	readonly groups: readonly string[];
	/**
	 * The groups it joined itself, which it keeps across a reload; its
	 * scopes are worked out again. Missing from an older presence, whose
	 * groups were all joined.
	 */
	readonly joined?: readonly string[];
	/** The peers it has stopped reaching it (see stop.ts). */
	readonly stops?: readonly Stop[];
	/** Its work in a phrase: the quest's title and summary, or where it runs. */
	readonly worksOn: string;
	/** What it owns by name: its quest, its repositories, its groups. */
	readonly owns: readonly string[];
	/** Whether it is in the middle of a run, as of when it last said. */
	readonly busy: boolean;
	/**
	 * What it is doing, as the desktop shows it: `listening` when idle,
	 * `busy` mid-run, `waiting` when idle with a want standing, `paused`
	 * when its person paused it, over all the rest. Missing from an
	 * older presence, where `busy` and `wants` say the same.
	 */
	readonly state?: PeerState;
	/** When the run in progress began, as an ISO time, while busy. */
	readonly since?: string;
	/**
	 * The step the run is on, such as the tool it runs, while busy. Said
	 * at most every 30 seconds, so it can lag the run by that much.
	 */
	readonly step?: string;
	/**
	 * What it is waiting on its person for, standing longest, while any
	 * want stands (see want.ts).
	 */
	readonly wants?: Want;
	/** The process holding it, when the machine would say. */
	readonly owner?: TickedOwner;
	/**
	 * The terminal window title pi gives its session, exactly, so the
	 * desktop can tell which window is this peer's without parsing it
	 * (see windowTitle).
	 */
	readonly title?: string;
	/**
	 * The address of the orchestrator its quest answers to, when one is
	 * above it (see internal/quest/orchestration.ts). The mesh resolves
	 * "the orchestrator" from this alone.
	 */
	readonly orchestratedBy?: string;
	/**
	 * The address of the orchestration it heads, when its quest
	 * orchestrates and it is the session playing the role: the one that
	 * signs with the quest's address, which is the one that had it first.
	 */
	readonly orchestrates?: string;
	/**
	 * The machine it runs on, when that is another one: a mycelium node
	 * writes the presence of a session elsewhere here, with its owner
	 * taken out, since only its own machine can judge its process.
	 */
	readonly machine?: string;
	/** When it last said so, as an ISO time. */
	readonly at: string;
}

/** Where presence is kept, and what can be asked of it. */
export interface Presences {
	/** This session's presence, when it has published one. */
	of(session: string): Presence | undefined;
	/** Publish a peer's presence. */
	publish(presence: Presence): void;
	/** Every peer's presence. */
	all(): Presence[];
	/** Let go of a peer's presence, once it has ended. */
	forget(session: string): void;
	/** Let go of what nothing has touched since this time. */
	expire(before: number): void;
}

/**
 * What pi puts before the rest of a window title. Pi keeps its own
 * (APP_TITLE) out of its public exports; it is "π" unless a fork
 * renames the app.
 */
const PI_TITLE = "\u03c0";

/**
 * The window title pi sets for a session, as pi composes it: its mark,
 * the session's name when it has one, and the base name of the folder
 * it runs in, joined by " - ".
 */
export function windowTitle(
	sessionName: string | undefined,
	cwd: string,
): string {
	const folder = basename(cwd);
	return sessionName
		? `${PI_TITLE} - ${sessionName} - ${folder}`
		: `${PI_TITLE} - ${folder}`;
}

/** How much of the summary is said, which is enough to name the work. */
const SUMMARY_CHARS = 240;

/** What a peer's work is, as presence says it. */
export interface PeerWork {
	readonly worksOn: string;
	readonly owns: readonly string[];
	/** The groups the work puts it in (see scope.ts). */
	readonly scopes: readonly string[];
	/** Where its quest sits among orchestrations, by quest id. */
	readonly orchestration: Orchestration;
}

/** How far up a quest's parents are followed, against a loop. */
const MOST_PARENTS = 8;

/** What this session's peer works on and owns, from its quest. */
export function workOf(
	sessionId: string,
	groups: readonly string[],
	cwd: string,
	records: QuestRecords,
): PeerWork {
	const here = cwd !== homedir() ? [basename(cwd)] : [];
	// Owned as a message would mention them: harness, not #harness.
	const named = groups.map((group) => group.slice(1));
	const checkout = checkoutOf(cwd);
	const runsIn = checkout ? [repositoryName(checkout)] : [];
	const quest = loadedQuest(sessionId, records.sessions);
	const readme = quest ? readReadme(records.quests, quest) : undefined;
	const parsed = readme ? parseQuestFrontMatter(readme) : undefined;
	if (!quest || !parsed) {
		return {
			worksOn: `the work in ${cwd}`,
			owns: [...new Set([...runsIn, ...here, ...named])],
			scopes: scopesOf({ questChain: [], repositories: runsIn }),
			orchestration: {},
		};
	}
	const read = frontMatterReader(records, quest, parsed.frontMatter);
	// Only a tree still checked out names its repository: one taken away
	// since has no git config to read, and its folder's name is the
	// broker's (worktree-github-...), which would make a group nobody
	// else is in.
	const trees = (parsed.frontMatter.trees ?? []).flatMap((tree) =>
		[tree.repoRoot, tree.path]
			.filter((at): at is string => at !== undefined)
			.filter((at) => existsSync(join(at, ".git")))
			.slice(0, 1)
			.map(repositoryName),
	);
	const repositories = [...new Set([...trees, ...runsIn])];
	const orchestration = orchestrationOf(quest, read);
	return {
		worksOn: describe(parsed.body),
		owns: [...new Set([quest, ...repositories, ...here, ...named])],
		scopes: scopesOf({
			questChain: questChain(quest, parsed.frontMatter.parent, read),
			repositories,
			orchestrations: [orchestration.by, orchestration.heads].filter(
				(one): one is string => one !== undefined,
			),
		}),
		orchestration,
	};
}

/**
 * Each quest's front matter, read once for one working out of presence,
 * which reads the same parents for the quest chain and the orchestration.
 */
function frontMatterReader(
	records: QuestRecords,
	quest: string,
	own: QuestFrontMatter,
): (quest: string) => QuestFrontMatter | undefined {
	const read = new Map<string, QuestFrontMatter | undefined>([[quest, own]]);
	return (id) => {
		if (!read.has(id)) {
			const readme = readReadme(records.quests, id);
			read.set(
				id,
				readme ? parseQuestFrontMatter(readme)?.frontMatter : undefined,
			);
		}
		return read.get(id);
	};
}

/** A quest, then each parent up to its root, as their READMEs say. */
function questChain(
	quest: string,
	parent: string | null | undefined,
	read: (quest: string) => QuestFrontMatter | undefined,
): string[] {
	const chain = [quest];
	let next = parent;
	while (next && !chain.includes(next) && chain.length <= MOST_PARENTS) {
		chain.push(next);
		next = read(next)?.parent;
	}
	return chain;
}

/** Checkouts found for a folder, by the folder; they rarely change. */
const checkouts = new Map<string, string | undefined>();

/**
 * The checkout a folder is in, found by looking up for a `.git`, and
 * never the home directory's, which says nothing about the work.
 */
export function checkoutOf(cwd: string): string | undefined {
	if (checkouts.has(cwd)) return checkouts.get(cwd);
	let found: string | undefined;
	for (let at = cwd; at !== homedir(); at = dirname(at)) {
		if (existsSync(join(at, ".git"))) {
			found = at;
			break;
		}
		if (dirname(at) === at) break;
	}
	checkouts.set(cwd, found);
	return found;
}

/** Repository names already read, by checkout; they never change. */
const repositories = new Map<string, string>();

/**
 * The name of the repository checked out here, as people write it
 * (agentic-harness.pi), rather than the folder it sits in, which for a
 * worktree is a name only the tree broker uses. Read from the origin
 * remote in git's own config, without running git, since presence is
 * worked out often; the folder's name when there is no such remote.
 */
export function repositoryName(checkout: string): string {
	const known = repositories.get(checkout);
	if (known !== undefined) return known;
	const name = originName(checkout) ?? basename(checkout);
	repositories.set(checkout, name);
	return name;
}

function originName(checkout: string): string | undefined {
	try {
		const config = readFileSync(join(commonGitDir(checkout), "config"), "utf8");
		const origin = config
			.split(/^\[/m)
			.find((section) => section.startsWith('remote "origin"]'));
		const url = origin?.match(/^\s*url\s*=\s*(\S+)\s*$/m)?.[1];
		const name = url
			?.replace(/\/+$/, "")
			.split(/[/:]/)
			.pop()
			?.replace(/\.git$/, "");
		return name && name.length > 0 ? name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The git directory a checkout shares with its siblings: its own `.git`
 * folder, or for a worktree the one its `.git` file points through.
 */
function commonGitDir(checkout: string): string {
	const dotGit = join(checkout, ".git");
	let pointer: string;
	try {
		pointer = readFileSync(dotGit, "utf8");
	} catch {
		return dotGit;
	}
	const gitDir = pointer.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
	if (!gitDir) return dotGit;
	const own = isAbsolute(gitDir) ? gitDir : join(checkout, gitDir);
	try {
		const common = readFileSync(join(own, "commondir"), "utf8").trim();
		return isAbsolute(common) ? common : join(own, common);
	} catch {
		return dirname(dirname(own));
	}
}

/** The presence kept in this folder, one file per peer. */
export function createPresences(dir: string): Presences {
	const file = (session: string) =>
		join(dir, `${session.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
	return {
		of: (session) => read(file(session)),
		publish(presence) {
			mkdirSync(dir, { recursive: true });
			const path = file(presence.session);
			const staged = `${path}.${process.pid}.tmp`;
			writeFileSync(staged, JSON.stringify(presence));
			renameSync(staged, path);
		},
		all() {
			let files: string[] = [];
			try {
				files = readdirSync(dir).filter((name) => name.endsWith(".json"));
			} catch {
				return [];
			}
			return files
				.map((name) => read(join(dir, name)))
				.filter((one): one is Presence => one !== undefined);
		},
		forget: (session) => removeQuietly(file(session)),
		// A presence is current while its peer is, so only what a publish
		// staged and never renamed is old here; ended peers are forgotten.
		expire: (before) => removeStaged(dir, before),
	};
}

function read(path: string): Presence | undefined {
	try {
		return presenceFrom(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Presence read from outside, or nothing when it is not one. */
function presenceFrom(value: unknown): Presence | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const one = value as Record<string, unknown>;
	const strings = (list: unknown): list is string[] =>
		Array.isArray(list) && list.every((item) => typeof item === "string");
	if (
		typeof one.session !== "string" ||
		!strings(one.addresses) ||
		!strings(one.groups)
	) {
		return undefined;
	}
	return {
		session: one.session,
		addresses: one.addresses,
		groups: one.groups,
		...(strings(one.joined) ? { joined: one.joined } : {}),
		...(stopsFrom(one.stops).length > 0 ? { stops: stopsFrom(one.stops) } : {}),
		worksOn: typeof one.worksOn === "string" ? one.worksOn : "",
		owns: strings(one.owns) ? one.owns : [],
		busy: one.busy === true,
		...(isPeerState(one.state) ? { state: one.state } : {}),
		...(typeof one.since === "string" ? { since: one.since } : {}),
		...(typeof one.step === "string" ? { step: one.step } : {}),
		...(wantFrom(one.wants) ? { wants: wantFrom(one.wants) } : {}),
		...(isOwner(one.owner) ? { owner: keepTicks(one.owner) } : {}),
		...(typeof one.title === "string" ? { title: one.title } : {}),
		...(typeof one.orchestratedBy === "string"
			? { orchestratedBy: one.orchestratedBy }
			: {}),
		...(typeof one.orchestrates === "string"
			? { orchestrates: one.orchestrates }
			: {}),
		...(typeof one.machine === "string" && one.machine !== ""
			? { machine: one.machine }
			: {}),
		at: typeof one.at === "string" ? one.at : "",
	};
}

/** The quest's title and the start of its summary. */
function describe(body: string): string {
	const title = body.match(/^# (.+)$/m)?.[1]?.trim() ?? "";
	const summary =
		body
			.split(/^## .*Summary.*$/m)[1]
			?.split(/^## /m)[0]
			?.replace(/\s+/g, " ")
			.trim() ?? "";
	const opening =
		summary.length > SUMMARY_CHARS
			? `${summary.slice(0, SUMMARY_CHARS)}...`
			: summary;
	return [title, opening].filter(Boolean).join(": ");
}

function readReadme(quests: string, quest: string): string | undefined {
	try {
		return readFileSync(join(quests, quest, "README.md"), "utf8");
	} catch {
		return undefined;
	}
}
