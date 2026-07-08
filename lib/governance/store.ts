/**
 * The governance rule store: a durable, human-editable list of
 * captured behavioural rules.
 *
 * Rules persist as a JSON array in a single file so a person can
 * open it and edit or remove a rule directly, which the design
 * requires: a bad captured rule must be easy to fix or delete.
 * Writes go through a temp file and a rename so a crash mid-write
 * never leaves a half-written store.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GovernanceRule } from "./types.js";

/** A rule to add, without the fields the store assigns. */
export type NewRule = Pick<GovernanceRule, "text"> &
	Partial<Pick<GovernanceRule, "source">>;

/** A durable store of captured behavioural rules. */
export interface RuleStore {
	/** Every rule, in insertion order. */
	list(): GovernanceRule[];
	/** File a new rule and return it with its assigned fields. */
	add(rule: NewRule): GovernanceRule;
	/** Remove a rule by id; returns true when one was removed. */
	remove(id: string): boolean;
	/** Replace the entire rule set (used after a bulk edit). */
	replaceAll(rules: GovernanceRule[]): void;
}

/** Mint a short, collision-resistant rule id. */
function mintId(): string {
	return randomBytes(4).toString("hex");
}

/** True for a record with the string fields a rule requires. */
function isValidRule(value: unknown): value is GovernanceRule {
	const r = value as Partial<GovernanceRule>;
	return (
		typeof r?.id === "string" &&
		typeof r?.text === "string" &&
		typeof r?.createdAt === "string"
	);
}

/**
 * Read and parse the store file, tolerating a missing file. A
 * file that will not parse is moved aside (never overwritten in
 * place) so a hand-edit typo cannot silently erase every rule on
 * the next write; the caller then starts from empty. Malformed
 * individual entries are dropped rather than rendered as blanks.
 */
function readRules(path: string): GovernanceRule[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// No file yet: an empty store is the correct starting point.
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Preserve the unparseable file under a new name and remove it
		// from the path so the next read starts clean and the next
		// write does not clobber the user's (recoverable) content.
		try {
			renameSync(path, `${path}.corrupt-${Date.now()}`);
		} catch {
			// Could not move it aside; leave it and start empty anyway.
		}
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isValidRule);
}

/** Write the rule set atomically. */
function writeRules(path: string, rules: GovernanceRule[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.rules.${mintId()}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/**
 * Open the rule store backed by the file at `path`. Every
 * operation reads through to the file, so two extensions holding
 * their own store over the same path (correction capture and the
 * advisor) always see each other's writes, and a hand-edit is
 * picked up without a restart. Writes are atomic.
 */
export function openRuleStore(path: string): RuleStore {
	return {
		list() {
			return readRules(path);
		},
		add(rule) {
			const filed: GovernanceRule = {
				id: mintId(),
				text: rule.text.trim(),
				createdAt: new Date().toISOString(),
				...(rule.source ? { source: rule.source } : {}),
			};
			writeRules(path, [...readRules(path), filed]);
			return filed;
		},
		remove(id) {
			const current = readRules(path);
			const next = current.filter((r) => r.id !== id);
			const removed = next.length !== current.length;
			if (removed) writeRules(path, next);
			return removed;
		},
		replaceAll(next) {
			writeRules(path, [...next]);
		},
	};
}
