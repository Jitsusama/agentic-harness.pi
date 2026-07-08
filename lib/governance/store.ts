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

/** Read and parse the store file, tolerating a missing file. */
function readRules(path: string): GovernanceRule[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// No file yet: an empty store is the correct starting point.
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as GovernanceRule[]) : [];
	} catch {
		// A corrupt file must not crash the session; start empty
		// rather than throw, and the next write heals the file.
		return [];
	}
}

/** Write the rule set atomically. */
function writeRules(path: string, rules: GovernanceRule[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.rules.${mintId()}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/**
 * Open the rule store backed by the file at `path`. The file is
 * read once into memory; every mutation rewrites it atomically.
 */
export function openRuleStore(path: string): RuleStore {
	let rules = readRules(path);
	return {
		list() {
			return [...rules];
		},
		add(rule) {
			const filed: GovernanceRule = {
				id: mintId(),
				text: rule.text.trim(),
				createdAt: new Date().toISOString(),
				...(rule.source ? { source: rule.source } : {}),
			};
			rules = [...rules, filed];
			writeRules(path, rules);
			return filed;
		},
		remove(id) {
			const next = rules.filter((r) => r.id !== id);
			const removed = next.length !== rules.length;
			if (removed) {
				rules = next;
				writeRules(path, rules);
			}
			return removed;
		},
		replaceAll(next) {
			rules = [...next];
			writeRules(path, rules);
		},
	};
}
