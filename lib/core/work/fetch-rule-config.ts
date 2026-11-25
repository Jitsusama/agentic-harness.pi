/**
 * The `work` section's fetch rule for one checkout, as the package
 * config says it now.
 *
 * The work tool's own fetches follow it (`fetch-rules.ts`). So must a
 * provider that runs git with an exec of its own, as World's does:
 * when World's provider fetched a commit straight from origin, one
 * 4 to 6 GB walk ran outside the turn every other World fetch on the
 * machine waits for. Reading the rule here, rather than each provider
 * reading the config, keeps one reading of the section.
 */

import { realpathSync } from "node:fs";
import { loadPackageConfig } from "../../internal/config/loader.ts";
import { packageConfigPath } from "../../internal/paths.ts";
import { type FetchRule, parseWorkFetches } from "./fetch-rules.ts";

/** The package config's section for the work tool. */
const WORK_SLUG = "work";

/**
 * The fetch rule for the checkout whose git folder is `gitDir`, read
 * afresh from the config at `configPath`; nothing when it names none,
 * or can't be read, since a checkout nobody rules fetches as it always
 * did.
 */
export async function configuredFetchRule(
	gitDir: string,
	configPath: string = packageConfigPath(),
): Promise<FetchRule | undefined> {
	const loaded = await loadPackageConfig(configPath);
	if (!loaded.ok) return undefined;
	// A section written wrong fetches as it always did; the rest still holds.
	const { fetches } = parseWorkFetches(loaded.config.sections[WORK_SLUG]);
	// Keyed as written or as the folder really is, since git names it
	// by its real path and the person may name it through a link.
	return Object.entries(fetches).find(
		([folder]) => folder === gitDir || realPath(folder) === gitDir,
	)?.[1];
}

/** `path` with its links followed, or itself when it can't be read. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A folder that isn't there names no checkout git could be in.
		return path;
	}
}
