/**
 * Skills listed only where they apply.
 *
 * Every skill's name and description is in every session's prompt, read
 * again on every turn. The context audit of 25 October found the list
 * was a fifth of a fresh session's start, and that skills for one
 * place (the World monorepo's git, pull requests, stacks, layout and
 * tooling) were listed in sessions that never ran there. The person
 * says where such a skill applies, in the `loadout` section of the
 * package config:
 *
 *   "loadout": { "skills": { "shopify-world-*": ["~/world"] } }
 *
 * A key is a skill's name, or the start of names ending in `*`; its
 * folders are where a session must run for the skill to be listed.
 * The most specific key wins, and a skill no key names is listed
 * everywhere, as before. A skill left out can still be read by its
 * path; only its line in the list goes.
 */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";

/** Where each named skill applies: the folders a session must run under. */
export type SkillPlaces = Readonly<Record<string, readonly string[]>>;

/** The `loadout` section of the package config. */
export interface LoadoutSettings {
	readonly skills: SkillPlaces;
}

/** Read the `loadout` section; absent, every skill is listed everywhere. */
export function parseLoadoutSettings(
	value: unknown,
): { ok: true; value: LoadoutSettings } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, value: { skills: {} } };
	if (!isRecord(value))
		return { ok: false, error: "loadout must be an object" };
	const skills = value.skills ?? {};
	if (!isRecord(skills)) {
		return { ok: false, error: "loadout.skills must be an object" };
	}
	const places: Record<string, readonly string[]> = {};
	for (const [key, folders] of Object.entries(skills)) {
		if (
			!Array.isArray(folders) ||
			!folders.every((one) => typeof one === "string" && one.trim() !== "")
		) {
			return {
				ok: false,
				error: `loadout.skills["${key}"] must be a list of folders`,
			};
		}
		places[key] = folders;
	}
	return { ok: true, value: { skills: places } };
}

/** The skills to list for a session running in this folder. */
export function skillsHere<S extends { readonly name: string }>(
	skills: readonly S[],
	places: SkillPlaces,
	cwd: string,
	home: string = homedir(),
): S[] {
	if (Object.keys(places).length === 0) return [...skills];
	const here = resolve(cwd);
	return skills.filter((skill) => {
		const folders = placesOf(skill.name, places);
		return (
			folders === undefined ||
			folders.some((folder) => isUnder(here, expand(folder, home)))
		);
	});
}

/** The folders the most specific key naming this skill gives, if any. */
function placesOf(
	name: string,
	places: SkillPlaces,
): readonly string[] | undefined {
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
