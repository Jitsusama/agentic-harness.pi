/**
 * Channels: who hears what.
 *
 * Sessions on one machine work towards different ends, and mail about
 * one end is noise to a session working on another. So beside the
 * global channel every session is on, there are named ones a session
 * joins: `harness`, `optimus`, `optimus/power`. They nest, and a member
 * of a sub-channel also hears its parent, since whatever concerns the
 * whole of `optimus` concerns whoever is working on its power.
 *
 * A session's channels are kept by its session id, which survives a
 * reload and a restore, so a conversation stays in the networks it
 * joined. The record also carries the names the session goes by, which
 * is how a sender can tell a name nobody answers to from a real one.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** One session's place in the networks. */
export interface Membership {
	/** The pi session id, which outlives the process. */
	readonly session: string;
	/** The names it goes by, the one it signs with first. */
	readonly names: readonly string[];
	/** The named channels it has joined, without the leading #. */
	readonly channels: readonly string[];
}

/** Where memberships are kept, and what can be asked of them. */
export interface Memberships {
	/** This session's record, or an empty one when it has none yet. */
	of(session: string): Membership;
	/** Keep a session's record. */
	keep(membership: Membership): void;
	/** Every session's record. */
	all(): Membership[];
}

/**
 * A channel as it is written, made canonical: no leading #, lower
 * case, segments of letters, digits and dashes joined by /. Nothing
 * when it is not one, including the global channel, which is not
 * joined but simply there.
 */
export function channelName(written: string): string | undefined {
	const name = written.trim().replace(/^#/, "").toLowerCase();
	if (name === "" || name === "all" || name === "global") return undefined;
	const segments = name.split("/");
	return segments.every((segment) => /^[a-z0-9][a-z0-9-]*$/.test(segment))
		? name
		: undefined;
}

/**
 * Whether a session on these channels hears mail sent to this one:
 * when it is on it, or on one of its sub-channels.
 */
export function hears(channels: readonly string[], channel: string): boolean {
	return channels.some(
		(own) => own === channel || own.startsWith(`${channel}/`),
	);
}

/** The memberships kept in this folder. */
export function createMemberships(dir: string): Memberships {
	const file = (session: string) =>
		join(dir, `${session.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
	const read = (path: string): Membership | undefined => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			return isMembership(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	};
	return {
		of(session) {
			return read(file(session)) ?? { session, names: [], channels: [] };
		},
		keep(membership) {
			mkdirSync(dir, { recursive: true });
			const path = file(membership.session);
			const staged = `${path}.${process.pid}.tmp`;
			writeFileSync(staged, JSON.stringify(membership));
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
				.filter((one): one is Membership => one !== undefined);
		},
	};
}

function isMembership(value: unknown): value is Membership {
	if (typeof value !== "object" || value === null) return false;
	const one = value as Record<string, unknown>;
	const strings = (list: unknown) =>
		Array.isArray(list) && list.every((item) => typeof item === "string");
	return (
		typeof one.session === "string" &&
		strings(one.names) &&
		strings(one.channels)
	);
}
