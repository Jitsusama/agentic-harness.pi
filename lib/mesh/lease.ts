/**
 * Leases: expiring claims a peer holds on what it is in the middle of,
 * kept on a board every peer can read.
 *
 * The swarm's holds "mattered as presence more than as a gate": a peer
 * reaching for what another held was stopped once, told who, since
 * when and what, and went ahead beside it if it reached again, while
 * the holder heard. So a lease is presence first. It says what a peer
 * is changing, answering, holding off or running, and the mesh tells
 * those involved when two overlap, once. Nothing waits on a lease to
 * be granted, and none outlives what it claims:
 *
 * - **change:** a file this peer is editing, named by repository and
 *   path so two worktrees of one repository overlap. Taken by the
 *   harness on each edit; lapses with the run, or ten minutes after the
 *   last edit. A git command that rewrites a checkout's files (a
 *   branch switched, a hard reset, a stash) changes every file in it,
 *   so it claims the whole checkout, named by its path: two worktrees
 *   are two checkouts, and only peers in the one rewritten are touched.
 *   A pull is checked against others' changes the same way but claims
 *   nothing, since it only brings the branch up to date: two sessions
 *   installing
 *   one checkout with a pull stopped each other for ten minutes after.
 *   Each change lease says which checkout it is in.
 * - **answer:** a question this peer has a turn for, so the rest of a
 *   group leave it to it. Lapses with the run.
 * - **hold:** a hold this peer sent, until it answers or replaces it,
 *   or for two hours at most.
 * - **wait:** a hold another peer sent that holds up this peer's work,
 *   so the holder sees what waits on it, and this peer is given a turn
 *   to carry on when the hold ends.
 * - **heavy:** heavy work this peer runs on the machine, as whatever
 *   places it says through the lease event.
 *
 * Every lease also lapses when its holder is gone, which is asked of the
 * machine (see liveness.ts), never of a heartbeat. Each peer writes only
 * its own leases, one file per session, so no two writers meet. A
 * subagent claims as its parent's hand (see hand.ts) in a file of its
 * own that names the peer it works for, and the board counts those
 * leases as that peer's.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { checkoutOf, repositoryName } from "./presence.ts";
import {
	removeQuietly,
	removeStaged,
	senderOf,
	touchedAt,
	writeAtomically,
} from "./transport.ts";

/** What a lease claims. */
export type LeaseKind = "change" | "answer" | "hold" | "wait" | "heavy";

export const LEASE_KINDS: readonly LeaseKind[] = [
	"change",
	"answer",
	"hold",
	"wait",
	"heavy",
];

/** One claim on the board. */
export interface Lease {
	readonly kind: LeaseKind;
	/** What it claims: a file, a message's id, or a kind of heavy work. */
	readonly subject: string;
	/** When it was taken, as an ISO time. */
	readonly since: string;
	/** When it lapses unless renewed, as an ISO time. */
	readonly until: string;
	/** What it is for, in a phrase. */
	readonly why?: string;
	/** The checkout a change is in, by its path, when it is in one. */
	readonly checkout?: string;
}

/** Whether a change lease claims its whole checkout, not one file. */
export function claimsCheckout(lease: Lease): boolean {
	return lease.kind === "change" && lease.subject === lease.checkout;
}

/** One peer's leases, as the board keeps them. */
export interface Holding {
	readonly session: string;
	readonly leases: readonly Lease[];
	/** The peer whose hand claimed these, when a subagent did. */
	readonly handOf?: string;
}

/** The peer a holding's leases are claimed for. */
export function ownerOf(holding: Holding): string {
	return holding.handOf ?? holding.session;
}

/** How long a lease taken in a run lasts without being renewed. */
export const RUN_LEASE_MS = 10 * 60 * 1000;

/** The longest a hold stands, and so a wait on it. */
export const MOST_HOLD_MS = 2 * 60 * 60 * 1000;

/** How long heavy work is claimed for when whoever places it says not. */
export const HEAVY_MS = 60 * 60 * 1000;

/** The kinds that lapse when the run that took them ends. */
export const RUN_KINDS: ReadonlySet<LeaseKind> = new Set(["change", "answer"]);

/**
 * A lease is written again only when renewing moves its end this far,
 * so a run of edits to one file is one write, not one each.
 */
const RENEWAL_MS = 60 * 1000;

/**
 * The event any extension emits on pi's bus to say this peer is running
 * heavy work, or has stopped: `{ take: { subject, why?, ms? } }` or
 * `{ release: subject }`. The subject names the kind of work (`qemu`,
 * `nix build`), which is what two peers' heavy work overlaps on.
 */
export const LEASE_EVENT = "mesh:lease:v1";

/** What the lease event carries. */
export type LeaseEvent =
	| { readonly take: { subject: string; why?: string; ms?: number } }
	| { readonly release: string };

/** The lease event as read from the bus, or nothing when it is not one. */
export function leaseEventFrom(value: unknown): LeaseEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const event = value as Record<string, unknown>;
	if (typeof event.release === "string" && event.release.trim() !== "") {
		return { release: event.release.trim() };
	}
	if (typeof event.take !== "object" || event.take === null) return undefined;
	const take = event.take as Record<string, unknown>;
	if (typeof take.subject !== "string" || take.subject.trim() === "") {
		return undefined;
	}
	return {
		take: {
			subject: take.subject.trim(),
			...(typeof take.why === "string" ? { why: take.why } : {}),
			...(typeof take.ms === "number" && take.ms > 0 ? { ms: take.ms } : {}),
		},
	};
}

/** A heredoc's body, from the line after `<<WORD` to WORD alone. */
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;

/** A quoted string: single quotes, or double with its escapes. */
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

/** A git command that rewrites a checkout's files, and the checkout. */
export interface Rewrite {
	/** The checkout's path. */
	readonly checkout: string;
	/** The git command, as it was written. */
	readonly command: string;
	/** Whether it only brings the branch up to date, as a pull does. */
	readonly catchesUp: boolean;
}

/** Where a shell command's parts end, so each is read on its own. */
const PARTS = /&&|\|\||[;|\n]/;

/** What stash does that leaves the files alone. */
const STASH_READS = new Set(["list", "show", "drop", "clear", "create"]);

/**
 * The first git command in a shell command that rewrites a checkout's
 * files, read where the shell runs it as for heavy work: switching a
 * branch, a hard reset, a stash, a rebase, a merge or a pull, a
 * restore, a forced clean, a cherry-pick, a revert or an am. It runs in
 * the checkout `-C` names, else the last `cd` before it, else `cwd`.
 * A new branch made where the checkout stands rewrites nothing. A
 * folder the shell works out, from a variable, a substitution, quotes
 * or `cd -`, is unknown until a `cd` to a plain absolute path, and git
 * run there is missed: that claims too little, never too much. Read as
 * a path, `cd $C` was a folder inside `cwd`, so a rebase in another
 * worktree was claimed as one in the session's own checkout.
 */
export function rewriteIn(command: string, cwd: string): Rewrite | undefined {
	const runs = command.replace(HEREDOC, "\n").replace(QUOTED, "''");
	let dir: string | undefined = cwd;
	for (const part of runs.split(PARTS)) {
		const words = part.trim().split(/\s+/);
		if (words[0] === "cd") {
			dir = words.length === 1 ? homedir() : movedTo(dir, words.slice(1));
			continue;
		}
		let at = words.findIndex((word) => !/^\w+=/.test(word));
		if (words[at] !== "git") continue;
		let runsIn = dir;
		for (at += 1; words[at]?.startsWith("-"); at += 1) {
			if (words[at] === "-C" || words[at] === "-c") {
				if (words[at] === "-C" && words[at + 1]) {
					runsIn = movedTo(runsIn, [words[at + 1] ?? ""]);
				}
				at += 1;
			}
		}
		if (runsIn === undefined) continue;
		if (!rewrites(words[at] ?? "", words.slice(at + 1))) continue;
		const checkout = checkoutOf(runsIn);
		if (checkout) {
			return {
				checkout,
				command: part.trim(),
				catchesUp: words[at] === "pull",
			};
		}
	}
	return undefined;
}

/** Whether this git subcommand, with these arguments, rewrites files. */
function rewrites(verb: string, args: readonly string[]): boolean {
	switch (verb) {
		case "checkout":
			return !(/^-[bB]$|^--orphan$/.test(args[0] ?? "") && args.length <= 2);
		case "switch":
			return !(/^-[cC]$|^--create$/.test(args[0] ?? "") && args.length <= 2);
		case "reset":
			return args.some((arg) => /^--(?:hard|merge|keep)$/.test(arg));
		case "stash":
			return !STASH_READS.has(args[0] ?? "");
		case "clean":
			return (
				args.some((arg) => /^-\w*f|^--force$/.test(arg)) &&
				!args.some((arg) => /^-\w*n|^--dry-run$/.test(arg))
			);
		case "restore":
		case "rebase":
		case "merge":
		case "pull":
		case "cherry-pick":
		case "revert":
		case "am":
			return true;
		default:
			return false;
	}
}

/**
 * The folder `cd` or `git -C` with these arguments moves to from `dir`,
 * or unknown where the shell would work it out: from a variable, a
 * substitution, a glob, quotes (blanked to `''` by then), `-`, or more
 * than one argument. A plain absolute path is known from anywhere.
 */
function movedTo(
	dir: string | undefined,
	args: readonly string[],
): string | undefined {
	const [path] = args;
	if (args.length !== 1 || !path || path === "-") return undefined;
	if (/[$`'"*?[\\]/.test(path)) return undefined;
	const expanded = expandHome(path);
	if (isAbsolute(expanded)) return resolve(expanded);
	return dir === undefined ? undefined : resolve(dir, expanded);
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/")
		? join(homedir(), path.slice(1))
		: path;
}

/** Whether a lease still stands by its clock. */
export function isCurrent(lease: Lease, now: number): boolean {
	return Date.parse(lease.until) > now;
}

/**
 * The most changes a receiver shows its classifier. A session in the
 * middle of a change holds three to fifteen files; past this many, the
 * latest say what it works on as well as all of them would.
 */
export const MOST_CHANGES_SHOWN = 12;

/**
 * The sessions a live peer is waiting on now: whoever sent a hold it is
 * parked on, and the hands working for them. Their heavy work goes first
 * in the machine queue, since it is what lets the waiting peers carry on.
 */
export function awaitedSessions(
	board: readonly Holding[],
	present: readonly {
		readonly session: string;
		readonly addresses: readonly string[];
	}[],
	now: number = Date.now(),
): Set<string> {
	const live = new Set(present.map((one) => one.session));
	const senders = new Set(
		board
			.filter((holding) => live.has(holding.session))
			.flatMap((holding) => holding.leases)
			.filter((lease) => lease.kind === "wait" && isCurrent(lease, now))
			.flatMap((lease) => senderOf(lease.subject) ?? []),
	);
	const awaited = new Set(
		present
			.filter((one) => one.addresses.some((address) => senders.has(address)))
			.map((one) => one.session),
	);
	for (const holding of board) {
		if (holding.handOf && awaited.has(holding.handOf)) {
			awaited.add(holding.session);
		}
	}
	return awaited;
}

/** What a peer is changing now, latest first: its standing change leases. */
export function changesOf(
	leases: readonly Lease[],
	now: number = Date.now(),
): string[] {
	return [
		...new Set(
			leases
				.filter((lease) => lease.kind === "change" && isCurrent(lease, now))
				.sort((one, other) => Date.parse(other.since) - Date.parse(one.since))
				.map((lease) => lease.subject),
		),
	].slice(0, MOST_CHANGES_SHOWN);
}

/** The board: every peer's leases, one file each. */
export interface Board {
	of(session: string): Holding | undefined;
	/** Write a peer's leases, or take its file away when it has none. */
	hold(holding: Holding): void;
	all(): Holding[];
	/**
	 * Take away the files of peers none of whose leases stand any more,
	 * as an ended peer leaves them.
	 */
	expire(now: number): void;
}

/** The board kept in this folder. */
export function createBoard(dir: string): Board {
	const file = (session: string) =>
		`${session.replace(/[^A-Za-z0-9-]/g, "_")}.json`;
	return {
		of: (session) => readHolding(join(dir, file(session))),
		hold(holding) {
			if (holding.leases.length === 0) {
				rmSync(join(dir, file(holding.session)), { force: true });
				return;
			}
			writeAtomically(dir, file(holding.session), JSON.stringify(holding));
		},
		all() {
			let files: string[] = [];
			try {
				files = readdirSync(dir).filter(
					(name) => name.endsWith(".json") && !name.startsWith("."),
				);
			} catch {
				return [];
			}
			return files
				.map((name) => readHolding(join(dir, name)))
				.filter((one): one is Holding => one !== undefined);
		},
		expire(now) {
			let files: string[] = [];
			try {
				files = readdirSync(dir).filter(
					(name) => name.endsWith(".json") && !name.startsWith("."),
				);
			} catch {
				return;
			}
			for (const name of files) {
				const path = join(dir, name);
				const touched = touchedAt(path);
				const holding = readHolding(path);
				const lapsed =
					holding !== undefined &&
					!holding.leases.some((lease) => isCurrent(lease, now));
				// Its peer may have taken a lease since it was read: only the
				// file as judged is taken away.
				if (lapsed && touchedAt(path) === touched) removeQuietly(path);
			}
			removeStaged(dir, now - HEAVY_MS);
		},
	};
}

function readHolding(path: string): Holding | undefined {
	try {
		return holdingFrom(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** A holding as read from outside, keeping the leases that read. */
export function holdingFrom(value: unknown): Holding | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const one = value as Record<string, unknown>;
	if (typeof one.session !== "string" || !Array.isArray(one.leases)) {
		return undefined;
	}
	return {
		session: one.session,
		leases: one.leases.flatMap(leaseFrom),
		...(typeof one.handOf === "string" && one.handOf !== ""
			? { handOf: one.handOf }
			: {}),
	};
}

function leaseFrom(value: unknown): Lease[] {
	if (typeof value !== "object" || value === null) return [];
	const one = value as Record<string, unknown>;
	if (
		!LEASE_KINDS.includes(one.kind as LeaseKind) ||
		typeof one.subject !== "string" ||
		typeof one.since !== "string" ||
		typeof one.until !== "string"
	) {
		return [];
	}
	return [
		{
			kind: one.kind as LeaseKind,
			subject: one.subject,
			since: one.since,
			until: one.until,
			...(typeof one.why === "string" ? { why: one.why } : {}),
			...(typeof one.checkout === "string" && one.checkout !== ""
				? { checkout: one.checkout }
				: {}),
		},
	];
}

/** A lease another peer holds, with whose it is. */
export interface Held {
	/** The peer it is claimed for, whether it or one of its hands took it. */
	readonly session: string;
	readonly lease: Lease;
}

/**
 * Other peers' current leases of this kind on this subject. A peer's
 * own hands are not others, nor is the peer a hand works for.
 */
export function othersOn(
	board: readonly Holding[],
	session: string,
	kind: LeaseKind,
	subject: string,
	now: number,
): Held[] {
	return board.flatMap((holding) =>
		holding.session === session || ownerOf(holding) === session
			? []
			: holding.leases
					.filter(
						(lease) =>
							lease.kind === kind &&
							lease.subject === subject &&
							isCurrent(lease, now),
					)
					.map((lease) => ({ session: ownerOf(holding), lease })),
	);
}

/**
 * Other peers' current change leases in this checkout, of files or of
 * the whole of it, as a peer about to rewrite it or change a file in
 * it needs to know. A peer's own hands are not others, as for
 * {@link othersOn}.
 */
export function othersIn(
	board: readonly Holding[],
	session: string,
	checkout: string,
	now: number,
): Held[] {
	return board.flatMap((holding) =>
		holding.session === session || ownerOf(holding) === session
			? []
			: holding.leases
					.filter(
						(lease) =>
							lease.kind === "change" &&
							lease.checkout === checkout &&
							isCurrent(lease, now),
					)
					.map((lease) => ({ session: ownerOf(holding), lease })),
	);
}

/**
 * What a change to this file is called on the board: the repository and
 * the path inside it when the file is in a checkout, so two worktrees of
 * one repository name it alike, and the absolute path otherwise.
 */
export function changeSubject(path: string, cwd: string): string {
	return changeOf(path, cwd).subject;
}

/** A change to this file as the board names it, and its checkout. */
export function changeOf(
	path: string,
	cwd: string,
): { readonly subject: string; readonly checkout?: string } {
	const absolute = resolve(cwd, path);
	const checkout = checkoutOf(dirname(absolute));
	return checkout
		? {
				subject: `${repositoryName(checkout)}:${relative(checkout, absolute)}`,
				checkout,
			}
		: { subject: absolute };
}

/** This peer's own leases, kept on the board as they change. */
export interface OwnLeases {
	readonly leases: readonly Lease[];
	/** The current lease of this kind on this subject, if this peer holds one. */
	held(kind: LeaseKind, subject: string, now?: number): Lease | undefined;
	/**
	 * Take a lease, or renew the one held, for this long from now; a
	 * change says the checkout it is in.
	 */
	take(
		kind: LeaseKind,
		subject: string,
		ms: number,
		why?: string,
		now?: number,
		checkout?: string,
	): Lease;
	/** Give up a lease; answers the one given up, if there was one. */
	release(kind: LeaseKind, subject: string): Lease | undefined;
	/** Give up every lease of these kinds, as a run ending does. */
	releaseAll(kinds: ReadonlySet<LeaseKind>): void;
}

/**
 * Move a peer's leases from the session it carried on from to its new
 * one, as a log rolling over leaves it the same peer under a new id:
 * left behind, its holds would read as a gone holder's, and every peer
 * waiting on one would be told it had ended.
 */
export function carryLeases(board: Board, from: string, to: string): void {
	if (from === to) return;
	const before = board.of(from);
	if (!before) return;
	const kept = board.of(to)?.leases ?? [];
	board.hold({ session: to, leases: [...kept, ...before.leases] });
	board.hold({ session: from, leases: [] });
}

/**
 * This session's leases. What the board already holds for it is kept,
 * less what lapsed and what a run took, since a peer starting again is
 * in no run: its holds and waits outlive a reload, its changes do not.
 */
export function ownLeases(
	board: Board,
	session: string,
	now: number = Date.now(),
	handOf?: string,
): OwnLeases {
	const before = board.of(session)?.leases ?? [];
	let leases = before.filter(
		(lease) => !RUN_KINDS.has(lease.kind) && isCurrent(lease, now),
	);
	const write = () =>
		board.hold({
			session,
			leases,
			...(handOf !== undefined ? { handOf } : {}),
		});
	if (leases.length !== before.length) write();
	const find = (kind: LeaseKind, subject: string) =>
		leases.find((lease) => lease.kind === kind && lease.subject === subject);
	return {
		get leases() {
			return leases;
		},
		held(kind, subject, at = Date.now()) {
			const lease = find(kind, subject);
			return lease && isCurrent(lease, at) ? lease : undefined;
		},
		take(kind, subject, ms, why, at = Date.now(), checkout) {
			const until = new Date(at + ms).toISOString();
			const old = find(kind, subject);
			if (old && isCurrent(old, at)) {
				const moved = Date.parse(until) - Date.parse(old.until);
				if (moved < RENEWAL_MS && (why === undefined || why === old.why)) {
					return old;
				}
				const renewed: Lease = {
					...old,
					until: moved > 0 ? until : old.until,
					...(why !== undefined ? { why } : {}),
				};
				leases = leases.map((one) => (one === old ? renewed : one));
				write();
				return renewed;
			}
			const lease: Lease = {
				kind,
				subject,
				since: new Date(at).toISOString(),
				until,
				...(why !== undefined ? { why } : {}),
				...(checkout !== undefined ? { checkout } : {}),
			};
			leases = [...leases.filter((one) => one !== old), lease];
			write();
			return lease;
		},
		release(kind, subject) {
			const old = find(kind, subject);
			if (!old) return undefined;
			leases = leases.filter((one) => one !== old);
			write();
			return old;
		},
		releaseAll(kinds) {
			const kept = leases.filter((lease) => !kinds.has(lease.kind));
			if (kept.length === leases.length) return;
			leases = kept;
			write();
		},
	};
}
