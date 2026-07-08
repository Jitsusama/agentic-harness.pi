/**
 * Thin promise wrapper over the callback-based sqlite3
 * driver. sqlite3 is a native module, so it is lazy-imported
 * on first open; the rest of the observability code speaks
 * promises and never touches the driver directly.
 */

/** Minimal shape of the sqlite3 Database we depend on. */
interface Sqlite3Database {
	run(
		sql: string,
		params: readonly unknown[],
		cb: (err: Error | null) => void,
	): void;
	all(
		sql: string,
		params: readonly unknown[],
		cb: (err: Error | null, rows: unknown[]) => void,
	): void;
	exec(sql: string, cb: (err: Error | null) => void): void;
	close(cb: (err: Error | null) => void): void;
}

/** A promise-speaking handle to a SQLite database. */
export interface Db {
	run(sql: string, params?: readonly unknown[]): Promise<void>;
	all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
	exec(sql: string): Promise<void>;
	close(): Promise<void>;
}

/** Open a SQLite database at the given path (`:memory:` for tests). */
export async function openDb(dbPath: string): Promise<Db> {
	const sqlite3 = await import("sqlite3");
	const database: Sqlite3Database = new sqlite3.default.Database(dbPath);
	return {
		run: (sql, params = []) =>
			new Promise((resolve, reject) => {
				database.run(sql, params, (err) => (err ? reject(err) : resolve()));
			}),
		all: <T>(sql: string, params: readonly unknown[] = []) =>
			new Promise<T[]>((resolve, reject) => {
				database.all(sql, params, (err, rows) =>
					err ? reject(err) : resolve(rows as T[]),
				);
			}),
		exec: (sql) =>
			new Promise((resolve, reject) => {
				database.exec(sql, (err) => (err ? reject(err) : resolve()));
			}),
		close: () =>
			new Promise((resolve, reject) => {
				database.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
