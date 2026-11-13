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
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isOwner } from "../core/process/index.ts";
import { keepTicks, type TickedOwner } from "../internal/process-ticks.ts";
import { parseQuestFrontMatter } from "../internal/quest/frontmatter.ts";
import {
	type Orchestration,
	orchestrationOf,
	windowWorkspaceOf,
} from "../internal/quest/orchestration.ts";
import { parsedFiles } from "../internal/quest/parsed-file.ts";
import { isSealedStatus } from "../internal/quest/status.ts";
import { isRecord } from "../internal/record.ts";
import { isLanding, type Landing } from "../internal/session/landings.ts";
import {
	type RefusedWake,
	readRefusedWake,
	refusedWakePath,
} from "../internal/session/refused-wake.ts";
import { writeWhole } from "../internal/write-whole.ts";
import type { QuestFrontMatter } from "../quest/types.ts";
import type { TerminalSessionHandle } from "../terminal/index.ts";
import { loadedQuest, type QuestRecords, questAddress } from "./address.ts";
import {
	type MoveOff,
	type Moving,
	moveOffFrom,
	movingFrom,
} from "./moving.ts";
import { scopesOf } from "./scope.ts";
import { isStepDetail, type StepDetail } from "./step.ts";
import { type Stop, stopsFrom } from "./stop.ts";
import { removeQuietly, removeStaged } from "./transport.ts";
import { isUsage, type SessionUsage } from "./usage.ts";
import { type Want, wantFrom } from "./want.ts";

/** Every state a presence may say. */
export const PEER_STATES = [
	"listening",
	"busy",
	"waiting",
	"paused",
	"parked",
] as const;

/** What a peer is doing, as its presence says. */
export type PeerState = (typeof PEER_STATES)[number];

function isPeerState(value: unknown): value is PeerState {
	return (PEER_STATES as readonly unknown[]).includes(value);
}

/** The well-formed landings in a presence's field, or none. */
function landingsFrom(value: unknown): Landing[] {
	return Array.isArray(value) ? value.filter(isLanding) : [];
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
	/**
	 * The quest it has loaded, by id, so a reader such as the machine's
	 * mycelium node says which quest a session is on without picking it
	 * out of what it owns. Missing while it has none, and from an older
	 * presence.
	 */
	readonly quest?: string;
	/** Whether it is in the middle of a run, as of when it last said. */
	readonly busy: boolean;
	/**
	 * What it is doing, as the desktop shows it: `listening` when idle,
	 * `busy` mid-run, `waiting` when idle with a want standing, `paused`
	 * when its person paused it, over all the rest, and `parked` once it
	 * ended idle to hold no memory until it is woken (parked.ts). Missing
	 * from an older presence, where `busy` and `wants` say the same.
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
	/**
	 * What it landed within the day, newest first, at most five (see
	 * internal/session/landings.ts): its status, kept where an
	 * orchestrator reads it rather than sent. Missing while it has none.
	 */
	readonly landings?: readonly Landing[];
	/** The process holding it, when the machine would say. */
	readonly owner?: TickedOwner;
	/** A hosted conversation, independently live within its owner process. */
	readonly hosted?: {
		readonly host: string;
		readonly conversation: string;
		/**
		 * The words a window runs to view it: the join
		 * (scripts/host-join.ts), which becomes its viewer while the host
		 * holds it and carries on as plain pi once the host lets it go.
		 * Mycelium's node gives them as the session's attach.
		 */
		readonly view?: readonly string[];
	};
	/**
	 * The terminal window title pi gives its session, exactly, so the
	 * desktop can tell which window is this peer's without parsing it
	 * (see windowTitle).
	 */
	readonly title?: string;
	/**
	 * The terminal window it runs in, as the driver that drew it names it:
	 * for kitty, the window's id and kitty's remote-control socket. The
	 * desktop finds and raises a peer's window by this, since a title can
	 * be cut, shared or overridden. Missing when pi runs in no terminal a
	 * driver knows, and from an older presence.
	 */
	readonly terminal?: TerminalSessionHandle;
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
	/** Its window's niri workspace, by name (windowWorkspaceOf). */
	readonly workspace?: string;
	/**
	 * The machine it runs on, when that is another one: a mycelium node
	 * writes the presence of a session elsewhere here, with its owner
	 * taken out, since only its own machine can judge its process.
	 */
	readonly machine?: string;
	/**
	 * The quest it has loaded, as the launcher shows it, so the desktop
	 * draws a session's quest without reading its README (see QuestInfo).
	 * `quest` stays the id alone, as every peer reads it.
	 */
	readonly questInfo?: QuestInfo;
	/** The folder it runs in. Missing from an older presence. */
	readonly cwd?: string;
	/**
	 * The file its holder wakes it on, while it's parked: anything written
	 * there starts it again, and the holder deletes it. The same path its
	 * park marker names, said here so a mycelium node steering a parked
	 * session can wake it itself (KP0L6A, 8 November). A park from before
	 * the machine's latest boot names a holder that is gone: check the
	 * owner's bootId first.
	 */
	readonly wake?: string;
	/** The repository that folder is a checkout of, by name, when it is one. */
	readonly repo?: string;
	/**
	 * Every want standing, oldest first, each saying whether it is the
	 * person's to answer: an orchestrated session's question is its
	 * orchestrator's. `wants` stays the person's longest standing, as
	 * every peer reads it. Missing while none stands.
	 */
	readonly wanting?: readonly StandingWant[];
	/** The step a run is on, in full, while busy (see step.ts). */
	readonly stepDetail?: StepDetail;
	/** What its model calls took, today and last (see usage.ts). */
	readonly usage?: SessionUsage;
	/**
	 * While a move its person asked waits for it to be free: where to,
	 * since when, and what holds it now (lib/internal/session/move.ts).
	 */
	readonly moving?: Moving;
	/**
	 * The last move that was called off rather than made, and why, until
	 * another is asked (extensions/mesh-workflow/moving.ts).
	 */
	readonly moveOff?: MoveOff;
	/**
	 * Whether its log holds words a person wrote, so a person drives it
	 * (lib/internal/session/driven.ts); missing from a peer whose harness
	 * doesn't say.
	 */
	readonly driven?: boolean;
	/**
	 * The name Agents shows it under at the launcher's top, never folded,
	 * and the words that find it, as its README's `stands-at-top` says.
	 */
	readonly standsAtTop?: StandsAtTop;
	/** When it last said so, as an ISO time. */
	readonly at: string;
}

/** How a session stands at the launcher's top: its name, words and what. */
export interface StandsAtTop {
	readonly name: string;
	readonly keywords: readonly string[];
	/** A sentence saying what it is for, when its quest gives one. */
	readonly what?: string;
}

/** A want standing, and whether it is the person's to answer. */
export interface StandingWant extends Want {
	readonly forPerson: boolean;
}

/** A session's quest as the launcher draws it. */
export interface QuestInfo {
	readonly id: string;
	/** Its README's heading. */
	readonly title: string;
	/** The address it gives a peer: its id's last six letters. */
	readonly short: string;
	/** Its front matter's status, such as active or concluded. */
	readonly status: string;
}

/** Where presence is kept, and what can be asked of it. */
export interface Presences {
	/** This session's presence, when it has published one. */
	of(session: string): Presence | undefined;
	/** Publish a peer's presence. */
	publish(presence: Presence): void;
	/** Every peer's presence. */
	all(): Presence[];
	/**
	 * Why its host refused the last wake of a peer that says it is parked,
	 * while the refusal is kept beside its wake file
	 * (internal/session/refused-wake.ts); none for a peer not parked.
	 */
	refusal(presence: Presence): RefusedWake | undefined;
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
	/** The quest it has loaded, by id, when its README can be read. */
	readonly quest?: string;
	/** That quest as the launcher draws it. */
	readonly questInfo?: QuestInfo;
	/** The repository its folder is a checkout of, by name, when it is one. */
	readonly repo?: string;
	/** The groups the work puts it in (see scope.ts). */
	readonly scopes: readonly string[];
	/** Where its quest sits among orchestrations, by quest id. */
	readonly orchestration: Orchestration;
	/** The workspace its window belongs on, by name (see Presence). */
	readonly workspace?: string;
	/** Its quest hears only what is put to it (see attention.ts). */
	readonly hears?: "addressed";
	/** Its quest stands at the launcher's top (see Presence). */
	readonly standsAtTop?: StandsAtTop;
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
	const parsed = quest ? parsedReadme(records.quests, quest) : undefined;
	const repo = runsIn[0];
	if (!quest || !parsed) {
		return {
			...(repo ? { repo } : {}),
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
		quest,
		questInfo: {
			id: quest,
			title: titleOf(parsed.body),
			short: questAddress(quest),
			status: parsed.frontMatter.status,
		},
		...(repo ? { repo } : {}),
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
		workspace: questAddress(windowWorkspaceOf(quest, read) ?? quest),
		...(parsed.frontMatter.hears ? { hears: parsed.frontMatter.hears } : {}),
		...standingAtTop(parsed.frontMatter._extra?.["stands-at-top"]),
	};
}

/** A `stands-at-top` as `{name, keywords, what?}`, or nothing unnamed. */
function standingAtTop(said: unknown): { standsAtTop?: StandsAtTop } {
	const standsAtTop = standsAtTopFrom(said);
	return standsAtTop ? { standsAtTop } : {};
}

/** A standing at the top read from outside, or nothing. */
function standsAtTopFrom(said: unknown): StandsAtTop | undefined {
	if (!isRecord(said) || typeof said.name !== "string") return undefined;
	const name = said.name.trim();
	if (name === "") return undefined;
	const keywords = Array.isArray(said.keywords)
		? said.keywords
				.filter((word): word is string => typeof word === "string")
				.map((word) => word.trim())
				.filter((word) => word !== "")
		: [];
	const what = typeof said.what === "string" ? said.what.trim() : "";
	return { name, keywords, ...(what ? { what } : {}) };
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
			read.set(id, parsedReadme(records.quests, id)?.frontMatter);
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
	const kept = new Map<string, Kept<Presence>>();
	// Each file's parse, kept while the file is the one it was read from:
	// a publish renames a new file in, so its inode says a change, and
	// mtime and size say one written in place. Every pi lists every
	// presence three times a minute (the peer refresh, the live count and
	// the steer look), and a hundred parses each time were most of what
	// an idle pi allocated.
	const readKept = (path: string): Presence | undefined =>
		readStamped(kept, path, read);
	// A parked peer's refused wake, by the file it is kept in, read the
	// same way, so a listing costs a stat for each parked peer.
	const refusals = new Map<string, Kept<RefusedWake>>();
	return {
		of: (session) => readKept(file(session)),
		publish(presence) {
			mkdirSync(dir, { recursive: true });
			writeWhole(file(presence.session), JSON.stringify(presence));
		},
		all() {
			let files: string[] = [];
			try {
				files = readdirSync(dir).filter((name) => name.endsWith(".json"));
			} catch {
				return [];
			}
			const paths = new Set(files.map((name) => join(dir, name)));
			for (const path of kept.keys()) {
				if (!paths.has(path)) kept.delete(path);
			}
			const present = [...paths]
				.map(readKept)
				.filter((one): one is Presence => one !== undefined);
			// Each park names a wake of its own, so only the parked keep theirs.
			const sleeping = new Set(
				present.flatMap(({ state, wake }) =>
					state === "parked" && wake !== undefined
						? [refusedWakePath(wake)]
						: [],
				),
			);
			for (const path of refusals.keys()) {
				if (!sleeping.has(path)) refusals.delete(path);
			}
			return present;
		},
		refusal({ state, wake }) {
			if (state !== "parked" || wake === undefined) return undefined;
			return readStamped(refusals, refusedWakePath(wake), () =>
				readRefusedWake(wake),
			);
		},
		forget: (session) => removeQuietly(file(session)),
		// A presence is current while its peer is, so only what a publish
		// staged and never renamed is old here; ended peers are forgotten.
		expire: (before) => removeStaged(dir, before),
	};
}

/** A file's parse, and the file it came from, by its stat. */
interface Kept<T> {
	readonly stamp: string;
	readonly value: T | undefined;
}

/**
 * The file at `path` as `read` parses it, kept in `kept` while its inode,
 * mtime and size stay as they were; a file gone is forgotten.
 */
function readStamped<T>(
	kept: Map<string, Kept<T>>,
	path: string,
	read: (path: string) => T | undefined,
): T | undefined {
	let stamp: string;
	try {
		const stat = statSync(path);
		stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		// Gone since it was listed, or never there: nothing to read.
		kept.delete(path);
		return undefined;
	}
	const was = kept.get(path);
	if (was?.stamp === stamp) return was.value;
	const value = read(path);
	kept.set(path, { stamp, value });
	return value;
}

function read(path: string): Presence | undefined {
	try {
		return presenceFrom(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Whether a value read from a presence file is a terminal handle. */
function isTerminalHandle(value: unknown): value is TerminalSessionHandle {
	if (typeof value !== "object" || value === null) return false;
	const one = value as Record<string, unknown>;
	return (
		typeof one.driverId === "string" &&
		typeof one.kind === "string" &&
		typeof one.hostId === "string" &&
		typeof one.value === "string" &&
		(one.scope === undefined || typeof one.scope === "string")
	);
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
		...(typeof one.quest === "string" ? { quest: one.quest } : {}),
		busy: one.busy === true,
		...(isPeerState(one.state) ? { state: one.state } : {}),
		...(typeof one.since === "string" ? { since: one.since } : {}),
		...(typeof one.step === "string" ? { step: one.step } : {}),
		...(wantFrom(one.wants) ? { wants: wantFrom(one.wants) } : {}),
		...(landingsFrom(one.landings).length > 0
			? { landings: landingsFrom(one.landings) }
			: {}),
		...(isOwner(one.owner) ? { owner: keepTicks(one.owner) } : {}),
		...(isHostedPresence(one.hosted) ? { hosted: one.hosted } : {}),
		...(typeof one.title === "string" ? { title: one.title } : {}),
		...(isTerminalHandle(one.terminal) ? { terminal: one.terminal } : {}),
		...(typeof one.orchestratedBy === "string"
			? { orchestratedBy: one.orchestratedBy }
			: {}),
		...(typeof one.orchestrates === "string"
			? { orchestrates: one.orchestrates }
			: {}),
		...(typeof one.workspace === "string" && one.workspace !== ""
			? { workspace: one.workspace }
			: {}),
		...(typeof one.machine === "string" && one.machine !== ""
			? { machine: one.machine }
			: {}),
		...(isQuestInfo(one.questInfo) ? { questInfo: one.questInfo } : {}),
		...(typeof one.cwd === "string" ? { cwd: one.cwd } : {}),
		...(typeof one.wake === "string" && one.wake !== ""
			? { wake: one.wake }
			: {}),
		...(typeof one.repo === "string" ? { repo: one.repo } : {}),
		...(standingFrom(one.wanting).length > 0
			? { wanting: standingFrom(one.wanting) }
			: {}),
		...(isStepDetail(one.stepDetail) ? { stepDetail: one.stepDetail } : {}),
		...(isUsage(one.usage) ? { usage: one.usage } : {}),
		...(movingFrom(one.moving) ? { moving: movingFrom(one.moving) } : {}),
		...(moveOffFrom(one.moveOff) ? { moveOff: moveOffFrom(one.moveOff) } : {}),
		...(typeof one.driven === "boolean" ? { driven: one.driven } : {}),
		...standingAtTop(one.standsAtTop),
		at: typeof one.at === "string" ? one.at : "",
	};
}

/** Whether a presence names a hosted conversation. */
function isHostedPresence(
	value: unknown,
): value is NonNullable<Presence["hosted"]> {
	return (
		typeof value === "object" &&
		value !== null &&
		"host" in value &&
		typeof value.host === "string" &&
		value.host !== "" &&
		"conversation" in value &&
		typeof value.conversation === "string" &&
		value.conversation !== "" &&
		(!("view" in value) ||
			(Array.isArray(value.view) &&
				value.view.length > 0 &&
				value.view.every((word) => typeof word === "string")))
	);
}

/** The wants a presence lists, skipping any this version can't read. */
function standingFrom(value: unknown): StandingWant[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((one) => {
		const want = wantFrom(one);
		const forPerson = (one as { forPerson?: unknown } | null)?.forPerson;
		return want && typeof forPerson === "boolean"
			? [{ ...want, forPerson }]
			: [];
	});
}

function isQuestInfo(value: unknown): value is QuestInfo {
	if (typeof value !== "object" || value === null) return false;
	const { id, title, short, status } = value as Record<string, unknown>;
	return [id, title, short, status].every((one) => typeof one === "string");
}

/** A README's heading. */
function titleOf(body: string): string {
	return body.match(/^# (.+)$/m)?.[1]?.trim() ?? "";
}

/** The quest's title and the start of its summary. */
function describe(body: string): string {
	const title = titleOf(body);
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

/**
 * Quest READMEs, each parsed again only once it changes. Every peer
 * works out its presence from its quest and each parent's on every
 * refresh, and orchestrators' front matter runs to tens of kilobytes
 * of YAML: on 11 November an idle pi allocated 35 MB in 90 s parsing
 * READMEs that hadn't changed.
 */
const readmes = parsedFiles(parseQuestFrontMatter);

/**
 * Whether the quest `quest` under `quests` has ended, concluded or
 * retired. A quest whose README can't be read hasn't, since it may only
 * be being written.
 */
export function questEnded(quests: string, quest: string): boolean {
	return isSealedStatus(parsedReadme(quests, quest)?.frontMatter.status);
}

function parsedReadme(
	quests: string,
	quest: string,
): ReturnType<typeof parseQuestFrontMatter> {
	try {
		return readmes(join(quests, quest, "README.md"));
	} catch {
		// A quest whose README can't be read works out as no quest.
		return undefined;
	}
}
