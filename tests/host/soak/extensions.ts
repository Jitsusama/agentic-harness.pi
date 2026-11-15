/**
 * Whether a side's pi can load every extension it was given. Each is a
 * link from the agent folder's extensions into the harness, and pi
 * skips a link whose target has gone without a word, starting faster
 * for the extensions it lacks. A tree that vanishes under a run, as a
 * lender's copy can, would then read as a quick start rather than the
 * fault it is.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The extensions in `agentDir` whose link leads nowhere, by name; none
 * when the folder itself is gone, which `missingFault` says apart.
 */
export function missingExtensions(agentDir: string): string[] {
	const folder = join(agentDir, "extensions");
	if (!existsSync(folder)) return [];
	return readdirSync(folder)
		.filter((name) => !existsSync(join(folder, name)))
		.sort();
}

/**
 * The fault for `side`'s extensions missing `when`, the folder holding
 * them included, or none when every one is there.
 */
export function missingFault(
	side: string,
	agentDir: string,
	when: string,
): string | undefined {
	const folder = join(agentDir, "extensions");
	if (!existsSync(folder))
		return `${side} had no extensions folder ${when}: ${folder}`;
	const missing = missingExtensions(agentDir);
	if (missing.length === 0) return undefined;
	const count = `${missing.length} extension${missing.length === 1 ? "" : "s"}`;
	return `${side} lacked ${count} ${when}: ${missing.join(", ")}`;
}
