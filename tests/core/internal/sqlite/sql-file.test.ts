import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sqlFile } from "../../../../lib/core/internal/sqlite/sql-file.ts";

/** A `.sql` file holding the given text, as the URL a store would name it by. */
function fileOf(text: string): URL {
	const dir = mkdtempSync(join(tmpdir(), "sql-file-"));
	const path = join(dir, "query.sql");
	writeFileSync(path, text);
	return pathToFileURL(path);
}

describe("a SQL file", () => {
	it("reads as it is written when it names no values", () => {
		const text = "SELECT 1 AS one;\n";
		expect(sqlFile(fileOf(text))).toBe(text);
	});

	it("has each named value written in as a literal, every time it appears", () => {
		const url = fileOf(
			"SELECT * FROM turns WHERE gap_ms > :hour_ms OR idle_ms > :hour_ms;",
		);
		expect(sqlFile(url, { hour_ms: 3_600_000 })).toBe(
			"SELECT * FROM turns WHERE gap_ms > 3600000 OR idle_ms > 3600000;",
		);
	});

	it("leaves a bound parameter it wasn't given for the statement to bind", () => {
		const url = fileOf(
			"SELECT * FROM turns WHERE day = :day AND gap_ms > :gap;",
		);
		expect(sqlFile(url, { gap: 10 })).toBe(
			"SELECT * FROM turns WHERE day = :day AND gap_ms > 10;",
		);
	});

	it("writes in only the whole name, not a longer one it begins", () => {
		const url = fileOf("SELECT :slack, :slack_tokens;");
		expect(sqlFile(url, { slack: 1, slack_tokens: 2 })).toBe("SELECT 1, 2;");
	});

	it("refuses a value the file never names, as a misspelt one would be", () => {
		const url = fileOf("SELECT :hour_ms;");
		expect(() => sqlFile(url, { hours_ms: 1 })).toThrow(
			/never names :hours_ms/,
		);
	});

	it("refuses a number SQLite would read as something else", () => {
		const url = fileOf("SELECT :limit;");
		expect(() => sqlFile(url, { limit: Number.NaN })).toThrow(
			/only a finite number/,
		);
	});
});
