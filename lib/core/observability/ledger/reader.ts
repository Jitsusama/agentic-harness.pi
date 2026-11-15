/**
 * A read-only view of the ledger, for questions nobody wrote a report
 * for.
 *
 * Apart from the store because it changes when what a free query may
 * ask does, which is a matter of refusing statements and bounding
 * answers, not of how turns are written.
 */

import { openDb } from "../../internal/sqlite/db.ts";
import type { QueryAnswer } from "./types.ts";

/**
 * The most rows one query may return. A query past it is refused rather
 * than cut, since a cut answer reads as the whole one; aggregating or a
 * LIMIT is how to ask for less.
 */
export const LEDGER_QUERY_ROW_CAP = 5000;

/** A read-only view of a ledger, for questions nobody wrote a report for. */
export interface LedgerReader {
	/**
	 * Run one `SELECT` (or `WITH ... SELECT`) against the ledger's tables
	 * and views. Anything else is refused before it reaches the database,
	 * and the connection is read-only besides, so no query can change what
	 * the ledger holds. A query returning more than
	 * {@link LEDGER_QUERY_ROW_CAP} rows is refused rather than cut.
	 */
	query(sql: string): Promise<QueryAnswer>;
	close(): Promise<void>;
}

/**
 * Open a ledger for reading only. The file must exist and have been
 * opened by `openTurnStore` at this version, which is what creates
 * the views a query is written against.
 */
export async function openLedgerReader(dbPath: string): Promise<LedgerReader> {
	const db = await openDb(dbPath, { readOnly: true });
	await db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
	return {
		query: async (sql) => {
			const statement = singleSelect(sql);
			// On lines of their own, so a trailing comment in the query cannot
			// swallow the bound.
			const rows = await db.all<Record<string, unknown>>(
				`SELECT * FROM (\n${statement}\n) LIMIT ${LEDGER_QUERY_ROW_CAP + 1}`,
			);
			if (rows.length > LEDGER_QUERY_ROW_CAP) {
				throw new Error(
					`The query returned more than ${LEDGER_QUERY_ROW_CAP} rows. ` +
						"Aggregate it, or add a LIMIT.",
				);
			}
			return { columns: Object.keys(rows[0] ?? {}), rows };
		},
		close: () => db.close(),
	};
}

/**
 * The statement, if it is one `SELECT` or `WITH`, with a trailing
 * semicolon taken off. A semicolon anywhere else outside a quoted string
 * means a second statement, which is refused rather than guessed about.
 */
function singleSelect(sql: string): string {
	const body = sql.trim().replace(/;\s*$/, "");
	if (!/^(select|with)\b/i.test(body)) {
		throw new Error(
			"A ledger query is one SELECT, or WITH ... SELECT. Nothing else runs.",
		);
	}
	let quote: string | null = null;
	for (const character of body) {
		if (quote) {
			if (character === quote) quote = null;
		} else if (character === "'" || character === '"') {
			quote = character;
		} else if (character === ";") {
			throw new Error("A ledger query is one statement.");
		}
	}
	return body;
}
