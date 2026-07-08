/**
 * SQLite-backed memory store.
 *
 * Facts are keyed by a serialized scope so recall is a plain
 * lookup. Retention is by lifecycle, never by age: a fact
 * leaves recall only when invalidated, when its scope is
 * concluded, or never. The store is its own database file,
 * separate from the observability table.
 */

import { openDb } from "../internal/sqlite/db.js";
import { serializeScope } from "./scope.js";
import type {
	Fact,
	FactStatus,
	MemoryStore,
	RecallQuery,
	RetainInput,
	Scope,
} from "./types.js";

/** Default number of facts a single recall returns. */
const DEFAULT_RECALL_LIMIT = 20;

interface FactRow {
	id: number;
	scope: string;
	text: string;
	tags: string;
	source: string | null;
	status: FactStatus;
	created_at: number;
	recalled_count: number;
	last_recalled_at: number | null;
}

function rowToFact(row: FactRow): Fact {
	return {
		id: row.id,
		scope: row.scope,
		text: row.text,
		tags: JSON.parse(row.tags) as string[],
		...(row.source ? { source: row.source } : {}),
		status: row.status,
		createdAt: row.created_at,
		recalledCount: row.recalled_count,
		...(row.last_recalled_at !== null
			? { lastRecalledAt: row.last_recalled_at }
			: {}),
	};
}

/** Open (and migrate) a memory store at the given path. */
export async function openMemoryStore(dbPath: string): Promise<MemoryStore> {
	const db = await openDb(dbPath);
	await db.exec(`
		CREATE TABLE IF NOT EXISTS facts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			scope TEXT NOT NULL,
			text TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '[]',
			source TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			created_at INTEGER NOT NULL,
			recalled_count INTEGER NOT NULL DEFAULT 0,
			last_recalled_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS facts_scope_status ON facts (scope, status);
	`);

	const factById = async (id: number): Promise<Fact | null> => {
		const rows = await db.all<FactRow>("SELECT * FROM facts WHERE id = ?", [
			id,
		]);
		return rows[0] ? rowToFact(rows[0]) : null;
	};

	const api: MemoryStore = {
		async retain(input: RetainInput): Promise<Fact> {
			const scope = serializeScope(input.scope);
			const now = Date.now();
			await db.run(
				"INSERT INTO facts (scope, text, tags, source, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
				[
					scope,
					input.text,
					JSON.stringify(input.tags ?? []),
					input.source ?? null,
					now,
				],
			);
			const rows = await db.all<FactRow>(
				"SELECT * FROM facts WHERE scope = ? ORDER BY id DESC LIMIT 1",
				[scope],
			);
			return rowToFact(rows[0]);
		},

		async recall(query: RecallQuery): Promise<Fact[]> {
			const scopes = [serializeScope(query.scope)];
			if (query.includeGlobal !== false && query.scope.kind !== "global") {
				scopes.push("global");
			}
			const placeholders = scopes.map(() => "?").join(", ");
			const params: unknown[] = [...scopes];
			let where = `status = 'active' AND scope IN (${placeholders})`;
			if (query.text) {
				where += " AND (text LIKE ? OR tags LIKE ?)";
				params.push(`%${query.text}%`, `%${query.text}%`);
			}
			const limit = query.limit ?? DEFAULT_RECALL_LIMIT;
			params.push(limit);
			const rows = await db.all<FactRow>(
				`SELECT * FROM facts WHERE ${where} ORDER BY recalled_count DESC, created_at DESC LIMIT ?`,
				params,
			);
			if (rows.length > 0) {
				const now = Date.now();
				await db.run(
					`UPDATE facts SET recalled_count = recalled_count + 1, last_recalled_at = ? WHERE id IN (${rows
						.map(() => "?")
						.join(", ")})`,
					[now, ...rows.map((r) => r.id)],
				);
			}
			// Reflect the bumped stats in what we hand back.
			return rows.map((r) =>
				rowToFact({
					...r,
					recalled_count: r.recalled_count + 1,
					last_recalled_at: Date.now(),
				}),
			);
		},

		async reflect(query): Promise<string> {
			const facts = await api.recall({ scope: query.scope });
			if (facts.length === 0) return "No remembered facts for this scope.";
			const lines = facts.map((f) => `- ${f.text}`).join("\n");
			return `Remembered facts relevant to "${query.question}":\n${lines}`;
		},

		async edit(id, patch): Promise<Fact | null> {
			const sets: string[] = [];
			const params: unknown[] = [];
			if (patch.text !== undefined) {
				sets.push("text = ?");
				params.push(patch.text);
			}
			if (patch.tags !== undefined) {
				sets.push("tags = ?");
				params.push(JSON.stringify(patch.tags));
			}
			if (sets.length === 0) return factById(id);
			params.push(id);
			await db.run(`UPDATE facts SET ${sets.join(", ")} WHERE id = ?`, params);
			return factById(id);
		},

		async invalidate(id): Promise<void> {
			await db.run("UPDATE facts SET status = 'invalidated' WHERE id = ?", [
				id,
			]);
		},

		async concludeScope(scope: Scope, mode): Promise<number> {
			const key = serializeScope(scope);
			const before = await db.all<{ n: number }>(
				"SELECT COUNT(*) AS n FROM facts WHERE scope = ? AND status = 'active'",
				[key],
			);
			if (mode === "drop") {
				await db.run("DELETE FROM facts WHERE scope = ?", [key]);
			} else {
				await db.run(
					"UPDATE facts SET status = 'archived' WHERE scope = ? AND status = 'active'",
					[key],
				);
			}
			return before[0]?.n ?? 0;
		},

		async weakestBeyondCap(scope: Scope, cap: number): Promise<Fact[]> {
			const key = serializeScope(scope);
			const rows = await db.all<FactRow>(
				"SELECT * FROM facts WHERE scope = ? AND status = 'active' ORDER BY recalled_count ASC, created_at ASC",
				[key],
			);
			if (rows.length <= cap) return [];
			return rows.slice(0, rows.length - cap).map(rowToFact);
		},

		async close(): Promise<void> {
			await db.close();
		},
	};
	return api;
}
