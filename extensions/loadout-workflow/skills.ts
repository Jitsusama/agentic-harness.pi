/**
 * Skills and tools listed only where they apply.
 *
 * Every skill's name and description is in every session's prompt, read
 * again on every turn, and so is every on-demand tool's line in the
 * loadable index. The context audit of 25 October found the skill list
 * was a fifth of a fresh session's start, and that skills for one
 * place (the World monorepo's git, pull requests, stacks, layout and
 * tooling) were listed in sessions that never ran there. The person
 * says where such a skill or tool applies, in the `loadout` section of
 * the package config:
 *
 *   "loadout": {
 *     "skills": { "shopify-world-*": ["~/world"] },
 *     "tools": { "mastery_*": ["~/src/joel.gerber.pi"] }
 *   }
 *
 * A key is a name, or the start of names ending in `*`; its folders are
 * where a session must run for it to be listed. The most specific key
 * wins, a key with no folders lists its names nowhere, and a name no key
 * names is listed everywhere, as before. The package names its review
 * rounds' contracts so (PACKAGE_PLACES). A skill left out can still be
 * read by its path, and a tool left out can still be found with
 * `tool_search` or loaded by a skill that names it; only its line goes.
 */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";

/** Where each named skill or tool applies: the folders a session must run under. */
export type Places = Readonly<Record<string, readonly string[]>>;

/** The `loadout` section of the package config. */
export interface LoadoutSettings {
	readonly skills: Places;
	readonly tools: Places;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Read the `loadout` section; absent, everything is listed everywhere. */
export function parseLoadoutSettings(value: unknown): Parsed<LoadoutSettings> {
	if (value === undefined)
		return { ok: true, value: { skills: {}, tools: {} } };
	if (!isRecord(value))
		return { ok: false, error: "loadout must be an object" };
	const skills = parsePlaces("skills", value.skills);
	if (!skills.ok) return skills;
	const tools = parsePlaces("tools", value.tools);
	if (!tools.ok) return tools;
	return { ok: true, value: { skills: skills.value, tools: tools.value } };
}

/** Read one map of names to folders, named `field` in its errors. */
function parsePlaces(field: string, value: unknown): Parsed<Places> {
	const given = value ?? {};
	if (!isRecord(given)) {
		return { ok: false, error: `loadout.${field} must be an object` };
	}
	const places: Record<string, readonly string[]> = {};
	for (const [key, folders] of Object.entries(given)) {
		if (
			!Array.isArray(folders) ||
			!folders.every((one) => typeof one === "string" && one.trim() !== "")
		) {
			return {
				ok: false,
				error: `loadout.${field}["${key}"] must be a list of folders`,
			};
		}
		places[key] = folders;
	}
	return { ok: true, value: places };
}

/**
 * Where this package's own skills apply, before the person says.
 *
 * A review round's output contract is attached by path to the round's
 * isolated pi, where this extension never runs, so it is listed there
 * and needs listing nowhere else.
 */
const PACKAGE_PLACES: Places = Object.fromEntries(
	["audit", "council", "critique", "judge", "stack"].map((round) => [
		`review-${round}-format`,
		[],
	]),
);

/** The person's places over the package's own, theirs winning. */
export function withPackagePlaces(places: Places): Places {
	return { ...PACKAGE_PLACES, ...places };
}

/** The skills or tools to list for a session running in this folder. */
export function placedHere<S extends { readonly name: string }>(
	named: readonly S[],
	places: Places,
	cwd: string,
	home: string = homedir(),
): S[] {
	if (Object.keys(places).length === 0) return [...named];
	const here = resolve(cwd);
	return named.filter((one) => {
		const folders = placesOf(one.name, places);
		return (
			folders === undefined ||
			folders.some((folder) => isUnder(here, expand(folder, home)))
		);
	});
}

/** The folders the most specific key naming this name gives, if any. */
function placesOf(name: string, places: Places): readonly string[] | undefined {
	const exact = places[name];
	if (exact) return exact;
	const prefixes = Object.keys(places)
		.filter((key) => key.endsWith("*") && name.startsWith(key.slice(0, -1)))
		.sort((one, other) => other.length - one.length);
	const [nearest] = prefixes;
	return nearest === undefined ? undefined : places[nearest];
}

function expand(folder: string, home: string): string {
	const trimmed = folder.trim();
	return resolve(
		trimmed === "~"
			? home
			: trimmed.startsWith("~/")
				? `${home}/${trimmed.slice(2)}`
				: trimmed,
	);
}

function isUnder(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}${sep}`);
}
