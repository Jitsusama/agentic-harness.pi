/**
 * GraphQL documents kept in files of their own, read in by the module
 * that sends them, so an editor and a reader see them as GraphQL.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Read a `.graphql` document. It takes no values: whatever varies is a
 * variable the caller sends beside it, never text written into it.
 */
export function graphqlFile(url: URL): string {
	return readFileSync(fileURLToPath(url), "utf8");
}
