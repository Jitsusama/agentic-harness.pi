import { openDb } from "../../../../lib/core/internal/sqlite/db.ts";

/**
 * Take a ledger file back to a shape an older version wrote, for a test
 * of the migration that brings it forward. The views go first, since
 * the older shapes had none and SQLite will not drop a column a view
 * still reads.
 */
export async function toOlderShape(path: string, sql: string): Promise<void> {
	const raw = await openDb(path);
	const views = await raw.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'view'",
	);
	for (const { name } of views) await raw.exec(`DROP VIEW ${name}`);
	await raw.exec(sql);
	await raw.close();
}
