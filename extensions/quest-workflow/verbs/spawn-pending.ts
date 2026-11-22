/**
 * A host spawn whose answer never came, kept by quest, host kind and
 * what it asked, so the spawn asked again sends the same request id and
 * another ask, or its answer, leaves it be. The host answers an
 * id it already holds with that start's answer (host/service/repeats.ts),
 * so a retry after a timeout gets the first conversation, not a twin.
 * Only a hash of what was asked is kept, never the request, since it
 * carries the conversation's environment.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HostKind } from "../../../host/service/address.ts";
import {
	fingerprint,
	REPEAT_WINDOW_MS,
	type Repeatable,
} from "../../../host/service/repeats.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import { writeWhole } from "../../../lib/internal/write-whole.ts";

/** One spawn left unanswered, as its file holds it. */
interface Pending {
	readonly id: string;
	readonly what: string;
	readonly askedAt: number;
}

/** Where a quest's unanswered spawns are kept. */
export function pendingDir(): string {
	return join(stateDir("quest-workflow"), "spawn-pending");
}

/**
 * The id to send `request` under: the unanswered spawn's, when it asked
 * the same of the same kind of host for this quest within the window the
 * host keeps answers, else `fresh`.
 */
export function pendingId(
	where: { questId: string; kind: HostKind },
	request: Repeatable,
	fresh: string,
	options: { dir?: string; now?: number } = {},
): string {
	const what = hashOf(request);
	const pending = readPending(fileOf(where, what, options.dir));
	if (pending === undefined) return fresh;
	const now = options.now ?? Date.now();
	if (now - pending.askedAt > REPEAT_WINDOW_MS) return fresh;
	return pending.what === what ? pending.id : fresh;
}

/**
 * Keep `request` as unanswered, so the spawn asked again repeats its id.
 * Answers whether it was kept.
 */
export function noteUnanswered(
	where: { questId: string; kind: HostKind },
	request: Repeatable,
	options: { dir?: string; now?: number } = {},
): boolean {
	const what = hashOf(request);
	const pending: Pending = {
		id: request.id,
		what,
		askedAt: options.now ?? Date.now(),
	};
	try {
		writeWhole(
			fileOf(where, what, options.dir),
			`${JSON.stringify(pending)}\n`,
		);
		return true;
	} catch {
		// Unkept, a retry sends a new id, as every spawn did before, and the
		// spawn says to check the host's list rather than promise a repeat.
		return false;
	}
}

/** Forget `request` as unanswered, once the host has answered it. */
export function clearUnanswered(
	where: { questId: string; kind: HostKind },
	request: Repeatable,
	options: { dir?: string } = {},
): void {
	try {
		rmSync(fileOf(where, hashOf(request), options.dir), { force: true });
	} catch {
		// Left, it names an id the host already answered: a spawn asked
		// again gets that answer, and a different ask hashes apart.
	}
}

function fileOf(
	where: { questId: string; kind: HostKind },
	what: string,
	dir = pendingDir(),
): string {
	return join(dir, `${where.questId}.${where.kind}.${what.slice(0, 16)}.json`);
}

function hashOf(request: Repeatable): string {
	return createHash("sha256").update(fingerprint(request)).digest("hex");
}

function readPending(path: string): Pending | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// None kept, or torn: a fresh id is the safe answer.
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	if (!("id" in value && "what" in value && "askedAt" in value))
		return undefined;
	const { id, what, askedAt } = value;
	return typeof id === "string" &&
		typeof what === "string" &&
		typeof askedAt === "number"
		? { id, what, askedAt }
		: undefined;
}
