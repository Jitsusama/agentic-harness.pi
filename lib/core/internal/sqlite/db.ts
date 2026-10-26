/**
 * Thin promise wrapper over the callback-based sqlite3
 * driver, shared by the local structured stores (memory,
 * observability). sqlite3 is a native module, so it is
 * lazy-imported on first open; callers speak promises and
 * never touch the driver directly.
 */

/** Minimal shape of the sqlite3 Database we depend on. */
interface Sqlite3Database {
	run(
		sql: string,
		params: readonly unknown[],
		cb: (this: { changes: number }, err: Error | null) => void,
	): void;
	all(
		sql: string,
		params: readonly unknown[],
		cb: (err: Error | null, rows: unknown[]) => void,
	): void;
	exec(sql: string, cb: (err: Error | null) => void): void;
	close(cb: (err: Error | null) => void): void;
}

/** What a statement did to the table it ran against. */
export interface RunResult {
	/** Rows the statement inserted, updated or deleted. */
	readonly changes: number;
}

/** A promise-speaking handle to a SQLite database. */
export interface Db {
	run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
	all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
	exec(sql: string): Promise<void>;
	close(): Promise<void>;
}

/** How a database is opened. */
export interface OpenOptions {
	/**
	 * Open without write access, and without creating the file. Every
	 * statement that would change it fails in the driver.
	 */
	readonly readOnly?: boolean;
}

/** Open a SQLite database at the given path (`:memory:` for tests). */
export async function openDb(
	dbPath: string,
	options: OpenOptions = {},
): Promise<Db> {
	const sqlite3 = await import("sqlite3");
	const database: Sqlite3Database = await new Promise((resolve, reject) => {
		// The driver's own default is read-write, create and full mutex;
		// read-only swaps the first two and keeps the third.
		const access = options.readOnly
			? sqlite3.default.OPEN_READONLY
			: sqlite3.default.OPEN_READWRITE | sqlite3.default.OPEN_CREATE;
		const mode = access | sqlite3.default.OPEN_FULLMUTEX;
		// The driver reports a failed open through this callback and
		// nowhere else, so a missing read-only file would otherwise
		// surface as a confusing error on the first statement.
		const opened: Sqlite3Database = new sqlite3.default.Database(
			dbPath,
			mode,
			(err) => (err ? reject(err) : resolve(opened)),
		);
	});
	return {
		run: (sql, params = []) =>
			new Promise((resolve, reject) => {
				database.run(sql, params, function (err) {
					if (err) reject(err);
					else resolve({ changes: this.changes });
				});
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
