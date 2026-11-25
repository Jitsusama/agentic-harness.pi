/**
 * The ledger's store of billable turns: opening it, writing each kind
 * of record once, and reading the records back.
 *
 * The shape it writes is in `shape.ts`, what it reports in
 * `reports.ts`, and the free read-only query in `reader.ts`. The
 * public names they hold are said here too, so the ledger's index reads
 * them from one place.
 */

import { type Db, openDb } from "../../internal/sqlite/db.ts";
import { sqlFile } from "../../internal/sqlite/sql-file.ts";
import {
	type CostDimension,
	type CostSlice,
	costBy,
	type LedgerTotal,
	paybackReplay,
	regret,
	repeatedCalls,
	total,
	verifierOutcomes,
} from "./reports.ts";
import { FACT_COLUMNS, FILL_FACTS, INSERT_TURN, shapeLedger } from "./shape.ts";
import type {
	CallScope,
	DeclarationRecord,
	DroppedCallRecord,
	InnerCallRecord,
	InnerCallVia,
	PaybackReplay,
	RegretReport,
	RepeatedCall,
	SessionRecord,
	ToolCallRecord,
	TurnRecord,
	VerifierOutcome,
} from "./types.ts";

export {
	LEDGER_QUERY_ROW_CAP,
	type LedgerReader,
	openLedgerReader,
} from "./reader.ts";
export type { CostDimension, CostSlice, LedgerTotal } from "./reports.ts";

/** How many turns a write added, and how many it had already seen. */
export interface RecordOutcome {
	readonly inserted: number;
	readonly duplicates: number;
}

/** A content-addressed store of billable turns. */
export interface TurnStore {
	recordTurns(turns: readonly TurnRecord[]): Promise<RecordOutcome>;
	recordSession(session: SessionRecord): Promise<void>;
	recordCalls(calls: readonly ToolCallRecord[]): Promise<RecordOutcome>;
	queryCalls(): Promise<ToolCallRecord[]>;
	/** Arguments asked more than once in one session, heaviest first. */
	repeatedCalls(scope?: CallScope): Promise<RepeatedCall[]>;
	recordDropped(dropped: readonly DroppedCallRecord[]): Promise<RecordOutcome>;
	queryDropped(): Promise<DroppedCallRecord[]>;
	/** Record the calls tools made to other tools, once each. */
	recordInnerCalls(inner: readonly InnerCallRecord[]): Promise<RecordOutcome>;
	/** Every call a tool made to another, oldest first. */
	queryInnerCalls(): Promise<InnerCallRecord[]>;
	/** Record what system messages declared or took away, once each. */
	recordDeclarations(
		declarations: readonly DeclarationRecord[],
	): Promise<RecordOutcome>;
	/** Every declaration change, oldest first. */
	queryDeclarations(): Promise<DeclarationRecord[]>;
	/** Dropped calls asked again after the drop, with how many could have been. */
	regret(scope?: CallScope): Promise<RegretReport>;
	/** Pass, fail and unknown counts per verifier kind that ran at all. */
	verifierOutcomes(): Promise<VerifierOutcome[]>;
	/** How real compactions compare against the payback test. */
	paybackReplay(): Promise<PaybackReplay>;
	total(): Promise<LedgerTotal>;
	costBy(dimension: CostDimension): Promise<CostSlice[]>;
	/** Every session the ledger holds, for another store to join to. */
	sessions(): Promise<SessionRecord[]>;
	close(): Promise<void>;
}

/**
 * What carried an inner call, refusing one this store doesn't know, so
 * a carrier added later is never counted as a script without a word.
 */
function carrier(via: string): InnerCallVia {
	if (via === "codemode" || via === "tool_gateway_run_tool") return via;
	throw new Error(
		`An inner call says it went through "${via}", which the ledger doesn't know.`,
	);
}

const RECORD_SESSION = sqlFile(
	new URL("./record-session.sql", import.meta.url),
);

/** Bound variables per probe, well inside SQLite's default ceiling. */
const PROBE_CHUNK = 500;

/**
 * Open (creating if needed) a turn ledger at the given path. Safe to
 * point at the same file as the run store: the tables are disjoint and
 * WAL keeps readers clear of the single writer.
 */
export async function openTurnStore(
	dbPath: string,
	options: TurnStoreOptions = {},
): Promise<TurnStore> {
	const db = await openDb(dbPath);
	// NORMAL syncs the WAL at checkpoints, not at each commit, where FULL
	// made a fresh ledger wait on about 50 flushes. The ledger is an index
	// of the session logs, so a power cut costs it only its last commits,
	// which the next scan reads again; WAL never leaves it corrupt. The
	// busy timeout comes first, so the pragmas after it wait on a writer
	// too rather than failing at once.
	await db.exec(
		"PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
	);
	await shapeLedger(db);
	return new SqliteTurnStore(
		db,
		options.rowsPerTransaction ?? ROWS_PER_TRANSACTION,
	);
}

/** How a turn store writes. */
export interface TurnStoreOptions {
	/**
	 * Rows one transaction writes before it commits, {@link
	 * ROWS_PER_TRANSACTION} unless set. A test proving a pass longer than
	 * one transaction lands whole sets it small, rather than timing
	 * thousands of rows on a loaded machine.
	 */
	readonly rowsPerTransaction?: number;
}

/**
 * How many rows one transaction writes before it commits and lets go of
 * the ledger's lock. One transaction for a whole log held it past the
 * other connections' 5 s busy timeout: on 8 November the daily measure
 * died on SQLITE_BUSY at 06:17, and the spend tool hit it twice (16V6F4).
 * Small enough that a transaction ends in well under a second on a busy
 * machine; large enough that commits, each a disk sync, stay few.
 */
export const ROWS_PER_TRANSACTION = 500;

class SqliteTurnStore implements TurnStore {
	private readonly db: Db;
	private readonly rowsPerTransaction: number;

	constructor(db: Db, rowsPerTransaction: number) {
		this.db = db;
		this.rowsPerTransaction = rowsPerTransaction;
	}

	async recordTurns(turns: readonly TurnRecord[]): Promise<RecordOutcome> {
		// Collapse the batch against itself first, then ask the table once
		// which of the survivors it already holds. Counting rows per insert
		// instead would make a corpus pass quadratic: 40,000 turns is 1.6
		// billion scanned rows, which does not finish.
		const fresh = new Map<string, TurnRecord>();
		for (const t of turns) if (!fresh.has(t.digest)) fresh.set(t.digest, t);
		const known = await this.known([...fresh.keys()]);

		// Transactions of many rows rather than one per row: each row is
		// otherwise its own durable commit, which is disk-sync bound, and a
		// first pass over the corpus took 13 minutes on that shape.
		const inserted = await this.inTransactions([...fresh.values()], (chunk) =>
			this.writeAll(chunk, known),
		);
		return { inserted, duplicates: turns.length - inserted };
	}

	/**
	 * Write `rows` in transactions of `rowsPerTransaction`, so no
	 * write holds the lock long; answers how many rows `write` inserted.
	 * A chunk that fails is rolled back and stops the rest; the chunks
	 * before it stand, which a later pass, finding them held, keeps.
	 */
	private async inTransactions<T>(
		rows: readonly T[],
		write: (chunk: readonly T[]) => Promise<number>,
	): Promise<number> {
		let inserted = 0;
		const size = this.rowsPerTransaction;
		for (let at = 0; at < rows.length; at += size) {
			await this.db.exec("BEGIN");
			try {
				inserted += await write(rows.slice(at, at + size));
				await this.db.exec("COMMIT");
			} catch (error) {
				await this.db.exec("ROLLBACK");
				throw error;
			}
		}
		return inserted;
	}

	private async writeAll(
		fresh: readonly TurnRecord[],
		known: ReadonlySet<string>,
	): Promise<number> {
		let inserted = 0;
		for (const t of fresh) {
			if (known.has(t.digest)) {
				// Seen before, so not billed again, but the sighting is still
				// recorded: deduplicating must not hide that it happened.
				await this.sight(t);
				await this.fillFacts(t);
				continue;
			}
			// Another session indexing the same logs may have landed this row
			// since the table was asked, so what counts is whether this
			// statement wrote it, not whether the probe had seen it.
			const { changes } = await this.db.run(INSERT_TURN, [
				t.digest,
				t.entryId,
				t.sessionId,
				t.timestamp,
				t.kind,
				t.model,
				t.tokens.input,
				t.tokens.output,
				t.tokens.cacheRead,
				t.tokens.cacheWrite,
				t.tokens.total,
				t.cacheWrite1h,
				t.cost?.input ?? null,
				t.cost?.output ?? null,
				t.cost?.cacheRead ?? null,
				t.cost?.cacheWrite ?? null,
				t.cost?.total ?? null,
				t.droppedBefore,
				t.firstKeptEntryId,
				...FACT_COLUMNS.map((f) => f.value(t)),
			]);
			inserted += changes;
			await this.sight(t);
			if (changes === 0) await this.fillFacts(t);
		}
		return inserted;
	}

	async total(): Promise<LedgerTotal> {
		return await total(this.db);
	}

	/**
	 * Record tool calls, each once however many logs or concurrent passes
	 * hold it.
	 */
	async recordCalls(calls: readonly ToolCallRecord[]): Promise<RecordOutcome> {
		const fresh = new Map<string, ToolCallRecord>();
		for (const c of calls) if (!fresh.has(c.digest)) fresh.set(c.digest, c);
		const known = await this.knownCalls([...fresh.keys()]);

		const unknown = [...fresh.values()].filter((c) => !known.has(c.digest));
		const inserted = await this.inTransactions(unknown, async (chunk) => {
			let written = 0;
			for (const c of chunk) {
				// Ignored rather than refused: a concurrent pass over the same
				// logs may have landed it since the probe, which is not an error.
				const { changes } = await this.db.run(
					`INSERT OR IGNORE INTO tool_calls (
						digest, session_id, entry_id, call_id, timestamp, name,
						args_digest, path, result_chars, result_digest, is_error,
						verifier_kind
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						c.digest,
						c.sessionId,
						c.entryId,
						c.callId,
						c.timestamp,
						c.name,
						c.argsDigest,
						c.path,
						c.resultChars,
						c.resultDigest,
						// Null is not false: a call whose result never arrived
						// did not come back succeeding.
						c.isError === null ? null : c.isError ? 1 : 0,
						c.verifierKind,
					],
				);
				written += changes;
			}
			return written;
		});
		return { inserted, duplicates: calls.length - inserted };
	}

	async queryCalls(): Promise<ToolCallRecord[]> {
		const rows = await this.db.all<CallRow>(
			"SELECT * FROM tool_calls ORDER BY timestamp ASC",
		);
		return rows.map((row) => ({
			digest: row.digest,
			sessionId: row.session_id,
			entryId: row.entry_id,
			callId: row.call_id,
			timestamp: row.timestamp,
			name: row.name,
			argsDigest: row.args_digest,
			path: row.path,
			resultChars: row.result_chars,
			resultDigest: row.result_digest,
			isError: row.is_error === null ? null : row.is_error === 1,
			verifierKind: row.verifier_kind as ToolCallRecord["verifierKind"],
		}));
	}

	/** Pass, fail and unknown counts per verifier kind that ran at all. */
	async verifierOutcomes(): Promise<VerifierOutcome[]> {
		return await verifierOutcomes(this.db);
	}

	/** Arguments asked more than once inside one session. */
	async repeatedCalls(scope: CallScope = {}): Promise<RepeatedCall[]> {
		return await repeatedCalls(this.db, scope);
	}

	async recordDropped(
		dropped: readonly DroppedCallRecord[],
	): Promise<RecordOutcome> {
		const fresh = new Map<string, DroppedCallRecord>();
		for (const d of dropped) {
			if (!fresh.has(d.callDigest)) fresh.set(d.callDigest, d);
		}
		const known = await this.alreadyHeld("dropped_calls", [...fresh.keys()]);

		const unknown = [...fresh.values()].filter((d) => !known.has(d.callDigest));
		const inserted = await this.inTransactions(unknown, async (chunk) => {
			let written = 0;
			for (const d of chunk) {
				const { changes } = await this.db.run(
					`INSERT OR IGNORE INTO dropped_calls (
						digest, session_id, dropped_at_entry_id, dropped_at_timestamp
					) VALUES (?, ?, ?, ?)`,
					[d.callDigest, d.sessionId, d.droppedAtEntryId, d.droppedAtTimestamp],
				);
				written += changes;
			}
			return written;
		});
		return { inserted, duplicates: dropped.length - inserted };
	}

	async recordInnerCalls(
		inner: readonly InnerCallRecord[],
	): Promise<RecordOutcome> {
		const fresh = new Map<string, InnerCallRecord>();
		for (const call of inner) {
			if (!fresh.has(call.digest)) fresh.set(call.digest, call);
		}
		const known = await this.alreadyHeld("inner_calls", [...fresh.keys()]);
		const unknown = [...fresh.values()].filter((c) => !known.has(c.digest));
		const inserted = await this.inTransactions(unknown, async (chunk) => {
			let written = 0;
			for (const c of chunk) {
				const { changes } = await this.db.run(
					`INSERT OR IGNORE INTO inner_calls (
						digest, session_id, entry_id, outer_call_id, timestamp, name,
						via, status, duration_ms
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						c.digest,
						c.sessionId,
						c.entryId,
						c.outerCallId,
						c.timestamp,
						c.name,
						c.via,
						c.status,
						c.durationMs,
					],
				);
				written += changes;
			}
			return written;
		});
		return { inserted, duplicates: inner.length - inserted };
	}

	async queryInnerCalls(): Promise<InnerCallRecord[]> {
		const rows = await this.db.all<{
			digest: string;
			session_id: string;
			entry_id: string;
			outer_call_id: string;
			timestamp: string;
			name: string;
			via: string;
			status: string;
			duration_ms: number | null;
		}>("SELECT * FROM inner_calls ORDER BY timestamp ASC, digest ASC");
		return rows.map((row) => ({
			digest: row.digest,
			sessionId: row.session_id,
			entryId: row.entry_id,
			outerCallId: row.outer_call_id,
			timestamp: row.timestamp,
			name: row.name,
			via: carrier(row.via),
			status: row.status,
			durationMs: row.duration_ms,
		}));
	}

	async recordDeclarations(
		declarations: readonly DeclarationRecord[],
	): Promise<RecordOutcome> {
		// Keyed on session, entry and tool, so a grown log read again in
		// full inserts nothing it already gave.
		const inserted = await this.inTransactions(declarations, async (chunk) => {
			let written = 0;
			for (const d of chunk) {
				const { changes } = await this.db.run(
					`INSERT OR IGNORE INTO declarations (
							session_id, entry_id, seq, timestamp, tool, change, chars
						) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						d.sessionId,
						d.entryId,
						d.seq,
						d.timestamp,
						d.tool,
						d.change,
						d.chars,
					],
				);
				written += changes;
			}
			return written;
		});
		return { inserted, duplicates: declarations.length - inserted };
	}

	async queryDeclarations(): Promise<DeclarationRecord[]> {
		const rows = await this.db.all<{
			session_id: string;
			entry_id: string;
			seq: number;
			timestamp: string;
			tool: string;
			change: string;
			chars: number;
		}>("SELECT * FROM declarations ORDER BY session_id, timestamp, seq, tool");
		return rows.map((row) => ({
			sessionId: row.session_id,
			entryId: row.entry_id,
			seq: row.seq,
			timestamp: row.timestamp,
			tool: row.tool,
			change: row.change === "removed" ? "removed" : "added",
			chars: row.chars,
		}));
	}

	async queryDropped(): Promise<DroppedCallRecord[]> {
		const rows = await this.db.all<{
			digest: string;
			session_id: string;
			dropped_at_entry_id: string;
			dropped_at_timestamp: string;
		}>("SELECT * FROM dropped_calls ORDER BY dropped_at_timestamp ASC");
		return rows.map((row) => ({
			callDigest: row.digest,
			sessionId: row.session_id,
			droppedAtEntryId: row.dropped_at_entry_id,
			droppedAtTimestamp: row.dropped_at_timestamp,
		}));
	}

	/** Dropped calls asked again after the drop. */
	async regret(scope: CallScope = {}): Promise<RegretReport> {
		return await regret(this.db, scope);
	}

	/** Replay the payback test over compactions already in the ledger. */
	async paybackReplay(): Promise<PaybackReplay> {
		return await paybackReplay(this.db);
	}

	async recordSession(session: SessionRecord): Promise<void> {
		await this.db.run(RECORD_SESSION, [
			session.sessionId,
			session.cwd,
			session.repo,
			session.quest,
			session.firstSeen,
			session.lastSeen,
		]);
	}

	async costBy(dimension: CostDimension): Promise<CostSlice[]> {
		return await costBy(this.db, dimension);
	}

	async sessions(): Promise<SessionRecord[]> {
		const rows = await this.db.all<{
			session_id: string;
			cwd: string | null;
			repo: string | null;
			quest: string | null;
			first_seen: string | null;
			last_seen: string | null;
		}>(
			`SELECT session_id, cwd, repo, quest, first_seen, last_seen
			FROM sessions ORDER BY session_id`,
		);
		return rows.map((r) => ({
			sessionId: r.session_id,
			cwd: r.cwd,
			repo: r.repo,
			quest: r.quest,
			firstSeen: r.first_seen,
			lastSeen: r.last_seen,
		}));
	}

	async close(): Promise<void> {
		await this.db.close();
	}

	/**
	 * Give a held turn the facts a later scan learned. This is how a ledger
	 * indexed before a column existed gets it on the next rescan, and how a
	 * compaction indexed before its log said whether the run resumed gets
	 * told, without billing anything twice.
	 */
	private async fillFacts(t: TurnRecord): Promise<void> {
		const values = FACT_COLUMNS.map((f) => f.value(t));
		if (values.every((value) => value === null)) return;
		await this.db.run(FILL_FACTS, [...values, t.digest]);
	}

	private async sight(t: TurnRecord): Promise<void> {
		await this.db.run(
			"INSERT OR IGNORE INTO sightings (digest, session_id) VALUES (?, ?)",
			[t.digest, t.sessionId],
		);
	}

	/** Which of these call addresses the table already holds. */
	private async knownCalls(digests: readonly string[]): Promise<Set<string>> {
		return this.alreadyHeld("tool_calls", digests);
	}

	/** Which of these addresses the table already holds. */
	private async known(digests: readonly string[]): Promise<Set<string>> {
		return this.alreadyHeld("turns", digests);
	}

	/**
	 * Which of these digests a table already holds, probed in chunks so a
	 * corpus-sized batch stays inside SQLite's bound-variable ceiling.
	 */
	private async alreadyHeld(
		table: "turns" | "tool_calls" | "dropped_calls" | "inner_calls",
		digests: readonly string[],
	): Promise<Set<string>> {
		const found = new Set<string>();
		for (let i = 0; i < digests.length; i += PROBE_CHUNK) {
			const chunk = digests.slice(i, i + PROBE_CHUNK);
			const holes = chunk.map(() => "?").join(",");
			// The table name is a literal from a two-member union, not
			// caller input, so it cannot carry anything but itself.
			const rows = await this.db.all<{ digest: string }>(
				`SELECT digest FROM ${table} WHERE digest IN (${holes})`,
				chunk,
			);
			for (const r of rows) found.add(r.digest);
		}
		return found;
	}
}

interface CallRow {
	digest: string;
	session_id: string;
	entry_id: string;
	call_id: string;
	timestamp: string;
	name: string;
	args_digest: string;
	path: string | null;
	result_chars: number | null;
	result_digest: string | null;
	is_error: number | null;
	verifier_kind: string | null;
}
