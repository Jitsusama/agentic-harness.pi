/**
 * Captured rules said only where they apply.
 *
 * Every filed rule rides the resident prompt, read again on every
 * turn. The context audit of 25 October found a quarter of them were
 * for one kind of work (designing an interface, driving a browser, a
 * Nix project), read in every session whatever it did. A rule in
 * `governance/rules.json` may say when it applies:
 *
 *   "when": { "skill": "aesthetic" }   said when that skill is read
 *   "when": { "file": "flake.nix" }    resident where that file is in
 *                                      the working folder or above it
 *
 * A rule with no `when` is resident everywhere, as before. Core's
 * store keeps fields it does not know, so a hand-written `when`
 * survives a rule being filed or removed. The advisor still watches
 * every rule.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** When a rule applies, read from its record. */
export type RuleWhen =
	| { readonly skill: string }
	| { readonly file: string }
	| undefined;

/** When this rule applies; undefined is always. */
export function whenOf(rule: object): RuleWhen {
	const when = "when" in rule ? rule.when : undefined;
	if (typeof when !== "object" || when === null) return undefined;
	if ("skill" in when && typeof when.skill === "string" && when.skill) {
		return { skill: when.skill };
	}
	if ("file" in when && typeof when.file === "string" && when.file) {
		return { file: when.file };
	}
	return undefined;
}

/** The rules resident for a session running in this folder. */
export function residentRules<R extends object>(
	rules: readonly R[],
	cwd: string,
	exists: (path: string) => boolean = existsSync,
): R[] {
	return rules.filter((rule) => {
		const when = whenOf(rule);
		if (when === undefined) return true;
		if ("skill" in when) return false;
		return foundAbove(when.file, cwd, exists);
	});
}

/** The rules to say when this skill is read. */
export function rulesForSkill<R extends object>(
	rules: readonly R[],
	skill: string,
): R[] {
	return rules.filter((rule) => {
		const when = whenOf(rule);
		return when !== undefined && "skill" in when && when.skill === skill;
	});
}

/**
 * The skill a read path names, when it is a skill's instructions. The
 * name is the skill's folder, which matches the name in its front
 * matter for every skill today; a skill whose two differ is matched by
 * its folder.
 */
export function skillRead(path: string): string | undefined {
	if (basename(path) !== "SKILL.md") return undefined;
	return basename(dirname(path)) || undefined;
}

function foundAbove(
	file: string,
	cwd: string,
	exists: (path: string) => boolean,
): boolean {
	let folder = resolve(cwd);
	for (;;) {
		if (exists(join(folder, file))) return true;
		const parent = dirname(folder);
		if (parent === folder) return false;
		folder = parent;
	}
}
