/**
 * The desktop notices this session has up, one per kind, and taking
 * them back once they no longer apply.
 *
 * Joel, 11 November: a notice that drops him into a session that has
 * already moved on from it "is a waste of my time"; when it no longer
 * applies, it should disappear. A notice is raised when the session
 * needs him, and taken back when he answers, when he types, when a run
 * starts past it, when the absence ends or when the session ends.
 *
 * What is up is kept as plain ids in a session cell, so a reload's new
 * copy of this module can still take back what the old one raised.
 */

import { sessionCell } from "../../lib/core/session/index.ts";
import {
	type Notice,
	type NotifyDeps,
	notify,
	withdrawNotice,
} from "../../lib/internal/notify.ts";

/** What a notice is about: one of each kind is up at a time. */
export type NoticeKind = "held" | "blocked" | "asked" | "resting";

/** Every kind, for taking all of them back. */
export const EVERY_NOTICE: readonly NoticeKind[] = [
	"held",
	"blocked",
	"asked",
	"resting",
];

/** A notice raised: its token, and the desktop's id once it answers. */
interface Up {
	readonly token: number;
	readonly id?: number;
}

const CELL = "agentic-harness.away-workflow.notices";

let tokens = 0;

/** The notices up, by kind, for this session. */
function upNow(): Partial<Record<NoticeKind, Up>> {
	const cell = sessionCell<Partial<Record<NoticeKind, Up>>>(CELL);
	const up = cell.get();
	if (up) return up;
	const fresh: Partial<Record<NoticeKind, Up>> = {};
	cell.set(fresh);
	return fresh;
}

/**
 * Put `notice` up as this session's `kind`, taking back the one it
 * replaces. One taken back while it is still being shown is taken back
 * as soon as the desktop gives its id.
 */
export async function raiseNotice(
	kind: NoticeKind,
	notice: Notice,
	deps: NotifyDeps = {},
): Promise<void> {
	// Claimed before anything is awaited, so a withdrawal that comes
	// while this is shown still finds it.
	const up = upNow();
	const replaced = up[kind]?.id;
	tokens += 1;
	const token = tokens;
	up[kind] = { token };
	if (replaced !== undefined) await withdrawNotice({ id: replaced }, deps);
	const raised = await notify(notice, deps);
	if (raised?.id === undefined) {
		if (up[kind]?.token === token) delete up[kind];
		return;
	}
	if (up[kind]?.token === token) {
		up[kind] = { token, id: raised.id };
		return;
	}
	await withdrawNotice(raised, deps);
}

/** Take back this session's notices of these kinds. Never throws. */
export async function withdrawNotices(
	kinds: readonly NoticeKind[],
	deps: NotifyDeps = {},
): Promise<void> {
	const up = upNow();
	const ids: number[] = [];
	for (const kind of kinds) {
		const id = up[kind]?.id;
		delete up[kind];
		if (id !== undefined) ids.push(id);
	}
	await Promise.all(ids.map((id) => withdrawNotice({ id }, deps)));
}
