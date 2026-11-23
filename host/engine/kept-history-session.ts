/**
 * A session whose log kept history holds in part still counts and lists
 * every message of its log, as pi does from a whole open.
 *
 * pi's /session counts and /fork list read the session manager's entries,
 * and a held manager holds only the kept view: its usage totals already
 * read as before (kept-history.ts), but its message counts and the user
 * messages it offers to fork from would stop at the last compaction. So
 * each session pi builds here answers both with what the view left on
 * disk added back: the counts kept history took when it held the view,
 * and the user messages read from the log a line at a time when /fork
 * asks for them, never held.
 *
 * Only the session instance is wrapped, never pi's class, and only while
 * its manager holds a view: once the whole log is read back, or the
 * session switches to another log, pi's own answers are whole again.
 * When the log can't be read, /fork offers pi's own list, said once.
 */

import { contentText } from "@earendil-works/pi-ai";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/internal/record.ts";
import { logLines } from "../../lib/internal/session/rollover.ts";
import { type LeftOut, leftOutOf } from "./kept-history.ts";

/** A user message pi offers to fork from. */
interface ForkPoint {
	readonly entryId: string;
	readonly text: string;
}

/** The parts of pi's session that read its manager's messages. */
interface CountingSession {
	readonly sessionManager: unknown;
	getSessionStats(): SessionStats;
	getUserMessagesForForking(): ForkPoint[];
}

/** Says what to say, or the error that stopped something. */
type Report = (said: unknown) => void;

/** How every user message line of a log opens, as pi writes it. */
const MESSAGE_HEAD = '{"type":"message",';

/** What only a user message's line holds. */
const USER_ROLE = '"role":"user"';

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
	let toldUnread = false;
	session.getSessionStats = () => {
		const left = leftOutOf(session.sessionManager);
		return left ? withLeftOut(stats(), left) : stats();
	};
	session.getUserMessagesForForking = () => {
		const held = forks();
		const left = leftOutOf(session.sessionManager);
		if (!left) return held;
		try {
			return forkPoints(left.file, held);
		} catch (error) {
			if (!toldUnread) {
				toldUnread = true;
				report(
					new Error(
						`Couldn't read ${left.file} for the messages to fork from, so /fork offers only those since its last compaction: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					),
				);
			}
			return held;
		}
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
 * Every user message of the log at `file` with text, in the log's order
 * as pi lists them, then any `held` has that the log doesn't yet.
 */
function forkPoints(file: string, held: readonly ForkPoint[]): ForkPoint[] {
	const points: ForkPoint[] = [];
	const seen = new Set<string>();
	for (const line of logLines(file)) {
		const point = forkPointOf(line);
		if (!point || seen.has(point.entryId)) continue;
		seen.add(point.entryId);
		points.push(point);
	}
	for (const point of held) if (!seen.has(point.entryId)) points.push(point);
	return points;
}

/** The fork point a log's line is, when it is a user message with text. */
function forkPointOf(line: string): ForkPoint | undefined {
	if (!line.startsWith(MESSAGE_HEAD) || !line.includes(USER_ROLE)) return;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		// A line cut short by a crash, which pi's own open skips too.
		return;
	}
	if (!isRecord(entry) || entry.type !== "message") return;
	if (typeof entry.id !== "string" || !isRecord(entry.message)) return;
	const { role, content } = entry.message;
	if (role !== "user" || !isContent(content)) return;
	const text = contentText(content, "");
	return text ? { entryId: entry.id, text } : undefined;
}

/** Whether `content` is a message's content as pi-ai reads its text. */
function isContent(
	content: unknown,
): content is Parameters<typeof contentText>[0] {
	return (
		typeof content === "string" ||
		(Array.isArray(content) &&
			content.every((part) => isRecord(part) && typeof part.type === "string"))
	);
}
