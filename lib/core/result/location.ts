/**
 * Where a session's stored payloads live, and when they stop
 * living there.
 *
 * Stable session directories survive a hosted restart. Ownership records
 * distinguish a dead plain-pi process from a conversation held for resume.
 * A plain quit removes only its caller's payloads; a hosted quit retains
 * them until the durable catalogue confirms that conversation is unheld.
 *
 * The alternative, reaping by age, cannot tell a dead session's
 * payloads from a live session's, so it either deletes payloads
 * somebody is still querying or keeps payloads nobody can.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stateDir } from "../../internal/paths.ts";
import {
	type ArtifactReaping,
	claimArtifactDirectory,
	reapSessionArtifacts,
} from "../internal/artifacts/ownership.ts";
import { hosted, type SessionContext, sessionKeyOf } from "../session/index.ts";
import { createResultStore, type ResultStore } from "./store.ts";

/** Where every session's stored payloads are rooted. */
export const RESULT_ROOT = stateDir("tool-results");

/** Previous process-owned payload root, retained for citation adoption and crash reaping. */
export const LEGACY_RESULT_ROOT = path.join(os.tmpdir(), "pi-tool-results");

// The directory's mode lives with the code that creates it, in
// spill.ts. Nothing here makes a directory any more.

/**
 * How much disk one session's payloads may hold.
 *
 * Generous, because the point of storing is that the caller can
 * come back for detail later in a long session, and a quota that
 * evicts a page outline before it has been queried has cost the
 * context it was meant to save.
 */
export const SESSION_QUOTA_BYTES = 256 * 1024 * 1024;

/** The caller's stable payload directory, independent of the current process. */
export function sessionResultDir(ctx: SessionContext): string {
	const id = sessionKeyOf(ctx);
	if (!id || id === "." || id === "..")
		throw new Error("A result store needs a session id.");
	return path.join(RESULT_ROOT, encodeURIComponent(id));
}

/**
 * A store over this session's directory.
 *
 * Every family opens its own, because the store is its directory:
 * two instances over one directory see the same payloads and
 * enforce one quota between them. That is what lets one family
 * cite a handle another can read without either importing the
 * other, or a mutable instance being passed around a package that
 * has no place to keep one.
 *
 * Not memoized here on purpose. Session lifetime belongs to the
 * adapter, and an instance holds nothing worth reusing beyond
 * the directory it names.
 *
 * Names the directory without creating it. Creating it here made
 * opening a store a disk operation, and every family opens one
 * before handing it to the code that knows how to survive a
 * failed write: an unwritable temp directory threw straight out
 * of nine call sites and took the whole tool call with it, past
 * the one place that catches exactly this and answers anyway.
 * The write itself still creates what it needs.
 */
export function openSessionStore(ctx: SessionContext): ResultStore {
	const dir = sessionResultDir(ctx);
	const store = createResultStore({ dir, maxBytes: SESSION_QUOTA_BYTES });
	return {
		put(text) {
			const result = store.put(text);
			claimArtifactDirectory(dir, ctx);
			return result;
		},
		read: (handle) => store.read(handle),
		has: (handle) => store.has(handle),
	};
}

/** Whether a process is still running. */
export function isPidAlive(pid: number): boolean {
	try {
		// Signal 0 tests for the process without touching it.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists and belongs to somebody else, which is
		// still alive as far as reaping is concerned.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Remove payload directories no live process owns.
 *
 * The collaborators are parameters so a destructive sweep can be
 * tested against a throwaway root rather than the real one.
 */
function reapLegacyResults(opts: {
	root: string;
	isPidAlive: (pid: number) => boolean;
}): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(opts.root, { withFileTypes: true });
	} catch {
		// No root yet, so nothing was ever abandoned.
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const pid = Number(entry.name);
		// Anything not named for a pid was not made by us; leaving it
		// alone is cheaper than being wrong about whose it is.
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (opts.isPidAlive(pid)) continue;
		try {
			fs.rmSync(path.join(opts.root, entry.name), {
				recursive: true,
				force: true,
			});
		} catch {
			// It vanished under us or will not delete; either way the next
			// session will try again.
		}
	}
}

/** Reap proven abandoned session owners and explicitly supplied legacy pid roots. */
export async function reapAbandonedResults(
	opts: ArtifactReaping & {
		isPidAlive: (pid: number) => boolean;
		legacyRoots?: readonly string[];
	},
): Promise<void> {
	await reapSessionArtifacts(opts);
	for (const root of opts.legacyRoots ?? [])
		reapLegacyResults({ ...opts, root });
}

/** Remove plain-pi payloads on quit; hosted quit can mean a resumable host stop. */
export function cleanupSessionResults(ctx: SessionContext): void {
	if (hosted()) return;
	const dir = sessionResultDir(ctx);
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// A later start retries cleanup using the recorded process identity.
	}
}
