/**
 * Hosted conversations whose last window the person closed, so the
 * restore file stops offering their viewer back after a boot.
 *
 * A hosted conversation keeps running in its host whether or not a
 * window views it, and restore.json names it so the launcher's Reopen
 * Them All opens its viewer where it was. A window the person closed
 * by hand was a choice, though, and reopening it after the next boot
 * undid it. Its viewer says so as it goes (`{"type":"leave","why":
 * "closed"}`, KP0L6A's `mycelium attach`, 24 November), and once no
 * other viewer stays, the host keeps a mark here, one empty file a
 * conversation, which a window joining it again takes away.
 *
 * The host keeps it, not the conversation's own record, since a parked
 * conversation has no pi to write its record while its viewers stay,
 * and a record has one writer, its own process
 * (extensions/quest-workflow/sessions/records.ts). The host writes off
 * its thread, each conversation's in the order said; the restore file's
 * writer only asks whether a mark is there.
 */

import { existsSync, unlinkSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../../paths.ts";

/** Ids that are a file name and nothing more, as the records take them. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** Each conversation's marks still being written, in the order said. */
const writing = new Map<string, Promise<void>>();

/** Where the marks live, beside the session records. */
export function closedViewersDir(): string {
	return join(stateDir("quest-workflow"), "closed-viewers");
}

function markOf(sessionId: string, dir: string): string | undefined {
	return SAFE_SESSION_ID.test(sessionId) ? join(dir, sessionId) : undefined;
}

/**
 * Keep, or take away, the mark saying the person closed `sessionId`'s
 * last window, after any mark of it still being written. Rejects with
 * why the folder couldn't be written, leaving the mark as it was. The
 * folder is the realm's of the conversation it is called in, as its
 * records' are, read as it is called.
 */
export function keepViewerClosed(
	sessionId: string,
	closed: boolean,
): Promise<void> {
	const dir = closedViewersDir();
	const mark = markOf(sessionId, dir);
	if (!mark) return Promise.resolve();
	const before = writing.get(sessionId) ?? Promise.resolve();
	const write = async () => {
		if (!closed) return rm(mark, { force: true });
		await mkdir(dir, { recursive: true });
		await writeFile(mark, "");
	};
	// One failing write never stops the next from being made.
	const next = before.then(write, write);
	writing.set(sessionId, next);
	const settled = () => {
		if (writing.get(sessionId) === next) writing.delete(sessionId);
	};
	next.then(settled, settled);
	return next;
}

/** Whether the person closed `sessionId`'s last window, by its mark. */
export function viewerWasClosed(sessionId: string): boolean {
	const mark = markOf(sessionId, closedViewersDir());
	return mark !== undefined && existsSync(mark);
}

/** Drop `sessionId`'s mark as its record is forgotten, if it has one. */
export function forgetClosedViewer(sessionId: string): void {
	const mark = markOf(sessionId, closedViewersDir());
	if (!mark) return;
	try {
		unlinkSync(mark);
	} catch {
		// No mark, or already gone: there's nothing left to forget.
	}
}
