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
 *   last edit.
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
import { dirname, join, relative, resolve } from "node:path";
import { checkoutOf, repositoryName } from "./presence.ts";
import {
	removeQuietly,
	removeStaged,
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

/**
 * The heavy work a shell command runs, named as two peers' heavy work
 * overlaps on, or nothing for a command that is not heavy. A short list
 * of what loads this machine for minutes, first match winning, so a
 * flake check is not also read as a build.
 */
const HEAVY_WORK: readonly (readonly [RegExp, string])[] = [
	[/\bnix\s+flake\s+check\b/, "nix flake check"],
	[/\bnix\s+build\b|\bnix-build\b/, "nix build"],
	[/\bnixos-rebuild\b/, "nixos-rebuild"],
	[/\bqemu(?:-system-[\w-]+)?\b/, "qemu"],
	[/\bcargo\s+build\b/, "cargo build"],
];

/** A heredoc's body, from the line after `<<WORD` to WORD alone. */
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;

/** A quoted string: single quotes, or double with its escapes. */
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

/**
 * The work a command runs, read only where the shell runs it: text in
 * quotes or a heredoc names the work (a grep, a commit message, a PR
 * body) rather than running it. A command run through `sh -c '...'` is
 * missed, which claims too little, never too much.
 */
export function heavyWorkIn(command: string): string | undefined {
	const runs = command.replace(HEREDOC, "\n").replace(QUOTED, "''");
	return HEAVY_WORK.find(([pattern]) => pattern.test(runs))?.[1];
}

/** Whether a lease still stands by its clock. */
export function isCurrent(lease: Lease, now: number): boolean {
	return Date.parse(lease.until) > now;
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
 * What a change to this file is called on the board: the repository and
 * the path inside it when the file is in a checkout, so two worktrees of
 * one repository name it alike, and the absolute path otherwise.
 */
export function changeSubject(path: string, cwd: string): string {
	const absolute = resolve(cwd, path);
	const checkout = checkoutOf(dirname(absolute));
	return checkout
		? `${repositoryName(checkout)}:${relative(checkout, absolute)}`
		: absolute;
}

/** This peer's own leases, kept on the board as they change. */
export interface OwnLeases {
	readonly leases: readonly Lease[];
	/** The current lease of this kind on this subject, if this peer holds one. */
	held(kind: LeaseKind, subject: string, now?: number): Lease | undefined;
	/** Take a lease, or renew the one held, for this long from now. */
	take(
		kind: LeaseKind,
		subject: string,
		ms: number,
		why?: string,
		now?: number,
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
		take(kind, subject, ms, why, at = Date.now()) {
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
