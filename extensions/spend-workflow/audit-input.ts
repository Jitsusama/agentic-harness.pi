/**
 * Gathers what the weekly audit reports, from the ledger and the
 * session logs, so the `spend` tool and the measure script ask
 * the same questions and print the same answer.
 */

import {
	AUDIT_QUERIES,
	type AuditInput,
	periods,
	type Row,
	type Span,
} from "./audit.ts";
import { byRepo, logsSince, standingOf } from "./standing.ts";

/** Answers one read-only query against the ledger with its rows. */
export type AuditQuery = (sql: string) => Promise<readonly Row[]>;

/** Where and when to gather an audit. */
export interface AuditSources {
	/** The moment the audited period ends. */
	readonly now: number;
	/** How long it runs: a week unless a day is asked for. */
	readonly span?: Span;
	/** Where pi keeps its session logs. */
	readonly sessionsDir: string;
	/**
	 * The tools that load on demand. Left out, as a run with no pi
	 * session has to, the audit says nothing about them.
	 */
	readonly deferred?: readonly string[];
}

/** Gather the period's audit, held against the one before. */
export async function gatherAudit(
	query: AuditQuery,
	sources: AuditSources,
): Promise<AuditInput> {
	const span = sources.span ?? "week";
	const { current, prior } = periods(sources.now, span);
	const logs = logsSince(sources.sessionsDir, Date.parse(current.from));
	const prompts = (
		await Promise.all(logs.map((path) => standingOf(path)))
	).filter((one) => one !== undefined);
	const { deferred } = sources;
	const [
		now,
		before,
		rewrites,
		reads,
		errors,
		sessions,
		searches,
		hidden,
		questReadsNow,
		questReadsBefore,
		sessionsBefore,
	] = await Promise.all([
		query(AUDIT_QUERIES.spend(current)),
		query(AUDIT_QUERIES.spend(prior)),
		query(AUDIT_QUERIES.rewrites(current)),
		query(AUDIT_QUERIES.readsByRepo(current)),
		query(AUDIT_QUERIES.errors(current)),
		query(AUDIT_QUERIES.sessions(current)),
		query(AUDIT_QUERIES.searches(current)),
		deferred ? query(AUDIT_QUERIES.hidden(current, deferred)) : [],
		query(AUDIT_QUERIES.questReads(current)),
		query(AUDIT_QUERIES.questReads(prior)),
		query(AUDIT_QUERIES.sessions(prior)),
	]);
	const active = Number(sessions[0]?.sessions ?? 0);
	return {
		span,
		period: current,
		spend: { now: now[0] ?? {}, before: before[0] ?? {} },
		rewrites,
		reads,
		errors,
		standing: byRepo(prompts),
		unread: logs.length - prompts.length,
		...(deferred
			? {
					loading: {
						sessions: active,
						searches: searches[0] ?? {},
						hidden,
					},
				}
			: {}),
		questReads: {
			now: questReadsNow,
			before: questReadsBefore,
			active: {
				now: active,
				before: Number(sessionsBefore[0]?.sessions ?? 0),
			},
		},
	};
}
