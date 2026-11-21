/**
 * An extension placed where the subagent tool takes one from: pi's
 * installed packages under the sealed home, which a fence holds
 * read-only. The tool refuses any other (extensions/subagent-workflow/
 * fence-keep.ts), so a case handing its subagents one of these support
 * providers names it through here. The file placed only hands on the
 * provider's default export, so the provider still runs from this tree.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Seal } from "./seal.ts";

/** Where the sealed home's pi keeps its installed packages. */
function packagesOf(sealed: Seal): string {
	return join(sealed.home, ".local", "share", "pi-packages");
}

/**
 * Place `extension`, an absolute path, among the sealed home's installed
 * packages, and answer the path the subagent tool takes.
 */
export async function installedExtension(
	sealed: Seal,
	extension: string,
): Promise<string> {
	const folder = join(packagesOf(sealed), "support");
	await mkdir(folder, { recursive: true });
	const placed = join(folder, basename(extension));
	await writeFile(
		placed,
		`export { default } from ${JSON.stringify(extension)};\n`,
	);
	return placed;
}
