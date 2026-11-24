/**
 * A session whose log kept history holds in part still counts and lists
 * every message of its log, as pi does from a whole open.
 *
 * pi's /session counts and /fork list read the session manager's entries,
 * and a held manager holds only the kept view: its usage totals already
 * read as before (kept-history.ts), but its message counts and the user
 * messages it offers to fork from would stop at the last compaction. So
 * each session pi builds here answers both with what kept history took
 * as it held the view added back: the counts of the messages it left on
 * disk, and the text of every user message the log held then. Neither
 * reads the log again, so /fork never waits on it: listing a 360 MB log's
 * 628 user messages from disk took 0.7 to 2 s of the thread every
 * conversation in a host shares, where their full text measured 241 KB.
 *
 * Only the session instance is wrapped, never pi's class, and it adds
 * only while its manager holds a view: once the whole log is read back,
 * or the session switches to another log, it passes pi's own answers on.
 */

import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { type ForkPoint, type LeftOut, leftOutOf } from "./kept-history.ts";

/** The parts of pi's session that read its manager's messages. */
interface CountingSession {
	readonly sessionManager: unknown;
	getSessionStats(): SessionStats;
	getUserMessagesForForking(): ForkPoint[];
}

/** Says what to say, or the error that stopped something. */
type Report = (said: unknown) => void;

/** Whether `session` has the parts of pi's session that this wraps. */
function countsLikePi(session: object): session is CountingSession {
	return (
		"sessionManager" in session &&
		"getSessionStats" in session &&
		typeof session.getSessionStats === "function" &&
		"getUserMessagesForForking" in session &&
		typeof session.getUserMessagesForForking === "function"
	);
}

/** Whether this process has said that pi's session lacks what this wraps. */
let toldUnlikePi = false;

/**
 * Have `session` count and list the messages its held log left on disk,
 * as pi would from the whole log. A session without pi's counts or fork
 * list is left as it is, said once a process.
 */
export function countLeftOut(session: object, report: Report): void {
	if (!countsLikePi(session)) {
		if (!toldUnlikePi) {
			toldUnlikePi = true;
			report(
				"/session's counts and /fork's list stop at a held log's last compaction: pi's session no longer has the parts they're wrapped at",
			);
		}
		return;
	}
	const stats = session.getSessionStats.bind(session);
	const forks = session.getUserMessagesForForking.bind(session);
	session.getSessionStats = () => {
		const left = leftOutOf(session.sessionManager);
		return left ? withLeftOut(stats(), left) : stats();
	};
	session.getUserMessagesForForking = () => {
		const left = leftOutOf(session.sessionManager);
		return left ? withForks(forks(), left) : forks();
	};
}

/** `stats` with the messages `left` counted in. */
function withLeftOut(stats: SessionStats, left: LeftOut): SessionStats {
	return {
		...stats,
		userMessages: stats.userMessages + left.userMessages,
		assistantMessages: stats.assistantMessages + left.assistantMessages,
		toolCalls: stats.toolCalls + left.toolCalls,
		toolResults: stats.toolResults + left.toolResults,
		totalMessages: stats.totalMessages + left.totalMessages,
	};
}

/**
 * The log's whole fork list: what it held when the view was taken, then
 * those of `held` appended since, which pi wrote after them.
 */
function withForks(held: ForkPoint[], left: LeftOut): ForkPoint[] {
	const listed = new Set(left.forks.map((point) => point.entryId));
	return [...left.forks, ...held.filter((point) => !listed.has(point.entryId))];
}
