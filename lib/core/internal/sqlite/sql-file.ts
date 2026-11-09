/**
 * SQL kept in files of its own, read in by the store that runs it.
 *
 * A query written as a string in TypeScript is read by no SQL editor or
 * linter, and a value spliced into it is where quoting breaks. A `.sql`
 * beside the store is read as SQL by everything that reads SQL.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A value written into SQL: only a finite number, so it can't change what the SQL says. */
export type SqlLiteral = number;

/**
 * Read a `.sql` file, with each named value written in as a literal.
 *
 * A value is named in the file as a bind parameter, `:name`, so the
 * file still reads as SQL. It is written in rather than bound because a
 * view can't take bound parameters. A name the file never mentions is
 * refused, as a misspelt one would be, and so is a number that isn't
 * finite, since SQLite would read `NaN` as a column.
 */
export function sqlFile(
	url: URL,
	values: Readonly<Record<string, SqlLiteral>> = {},
): string {
	const path = fileURLToPath(url);
	let text = readFileSync(path, "utf8");
	for (const [name, value] of Object.entries(values)) {
		if (!Number.isFinite(value)) {
			throw new Error(
				`${path}: :${name} is ${value}, and only a finite number is written into SQL`,
			);
		}
		const named = new RegExp(`:${name}\\b`, "g");
		if (!named.test(text)) {
			throw new Error(`${path} never names :${name}, so it can't be given`);
		}
		text = text.replace(named, String(value));
	}
	return text;
}
