/**
 * Stamp every open quest made before quests recorded their realm with
 * the realm whose folder holds it, once.
 *
 * `quest create` writes `realm` from 12 November 2026; a quest without
 * one never crosses into a reader of another realm, so Estuary's inlet
 * would see nothing already under way (EY17AD, 12 November 2026). The
 * folder is the truth: home's quests belong to the home realm, and
 * `realms/<name>/` to that one. A quest whose parent is kept in another
 * realm's folder, or nowhere, is stamped by its own folder and listed.
 * Concluded and retired quests, and any already marked, are left alone,
 * and `updated` is kept, since nobody worked on them.
 *
 * Run it bare for what it would do; `--write` does it. Keep the
 * printout: the inlet's first read is checked against it.
 *
 *   node scripts/stamp-quest-realms.ts [--write]
 */

import { basename, dirname, join } from "node:path";
import { everyRealmsDir } from "../lib/internal/paths.ts";
import {
	discoverQuests,
	type QuestIndex,
} from "../lib/internal/quest/discovery.ts";
import { mutateQuestFrontMatter } from "../lib/internal/quest/mutate.ts";
import { sessionRealmName } from "../lib/internal/realm.ts";

/** One realm's quest folder. */
export interface RealmRoot {
	readonly realm: string;
	readonly quests: string;
}

/** What a stamp did, or would do, in one realm. */
export interface RealmStamp {
	readonly realm: string;
	/** Open quests given the realm, or that would be. */
	readonly stamped: number;
	/** Open quests already marked. */
	readonly marked: number;
	/** Concluded or retired quests, left unmarked. */
	readonly closed: number;
}

/** A quest kept in one realm's folder whose parent is kept elsewhere. */
export interface Disagreement {
	readonly id: string;
	readonly realm: string;
	readonly parent: string;
	/** The realm that keeps its parent, or null when none does. */
	readonly parentRealm: string | null;
}

/** What a stamp found. */
export interface StampReport {
	readonly write: boolean;
	readonly realms: readonly RealmStamp[];
	readonly disagreements: readonly Disagreement[];
	/** Quests already marked with a realm other than their folder's. */
	readonly misMarked: readonly { id: string; realm: string; marked: string }[];
	/** Quests a write was refused for, with why. */
	readonly refused: readonly { id: string; why: string }[];
}

const CLOSED = new Set(["concluded", "retired"]);

/** Stamp, or with `write` false only count, each open quest's realm. */
export function stampQuestRealms(opts: {
	readonly roots: readonly RealmRoot[];
	readonly write: boolean;
}): StampReport {
	const indexes = opts.roots.map((root) => ({
		...root,
		index: discoverQuests(root.quests, { dir: null }).index,
	}));
	const keeper = (id: string): string | null =>
		indexes.find(({ index }) => index.quests.has(id))?.realm ?? null;
	const disagreements: Disagreement[] = [];
	const misMarked: { id: string; realm: string; marked: string }[] = [];
	const refused: { id: string; why: string }[] = [];
	const realms = indexes.map(({ realm, index }) => {
		const counts = { realm, stamped: 0, marked: 0, closed: 0 };
		for (const [id, entry] of sortedQuests(index)) {
			const fm = entry.doc.frontMatter;
			if (CLOSED.has(fm.status)) {
				counts.closed += 1;
				continue;
			}
			if (fm.realm) {
				counts.marked += 1;
				if (fm.realm !== realm) misMarked.push({ id, realm, marked: fm.realm });
				continue;
			}
			if (fm.parent && !index.quests.has(fm.parent)) {
				disagreements.push({
					id,
					realm,
					parent: fm.parent,
					parentRealm: keeper(fm.parent),
				});
			}
			if (opts.write) {
				const result = mutateQuestFrontMatter(
					entry.dir,
					(now) => (now.realm ? undefined : { ...now, realm }),
					{ stampUpdated: false },
				);
				if (!result.ok) {
					refused.push({ id, why: result.guidance });
					continue;
				}
			}
			counts.stamped += 1;
		}
		return counts;
	});
	return { write: opts.write, realms, disagreements, misMarked, refused };
}

/** The printout: per realm, then every quest it couldn't simply stamp. */
export function formatStamp(report: StampReport): string {
	const verb = report.write ? "stamped" : "would stamp";
	const done = report.write ? "stamped" : "to be stamped";
	const lines = report.realms.map(
		(r) =>
			`${r.realm}: ${verb} ${r.stamped} open quests; ${r.marked} already marked; ${r.closed} concluded or retired, left alone.`,
	);
	for (const d of report.disagreements) {
		const where = d.parentRealm ?? "no realm";
		lines.push(
			`${d.id} is kept in ${d.realm} but its parent, ${d.parent}, in ${where}; ${done} ${d.realm} by its folder.`,
		);
	}
	for (const m of report.misMarked) {
		lines.push(
			`${m.id} is kept in ${m.realm} but already marked ${m.marked}; left as it is.`,
		);
	}
	for (const r of report.refused) {
		lines.push(`${r.id} wasn't written: ${r.why}`);
	}
	if (!report.write) lines.push("Nothing was written; run with --write to.");
	return `${lines.join("\n")}\n`;
}

/** A realm's quests in id order, so the printout reads the same each run. */
function sortedQuests(index: QuestIndex) {
	return [...index.quests.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Every realm this machine keeps quests for, home's named by its realm. */
function machineRoots(home: string): RealmRoot[] {
	return everyRealmsDir("data", "quest-workflow").map((dir, at) => ({
		realm: at === 0 ? home : basename(dirname(dir)),
		quests: join(dir, "quests"),
	}));
}

async function main(): Promise<void> {
	const home =
		sessionRealmName({ MYCELIUM_REALM: process.env.PI_HOME_REALM }) ??
		sessionRealmName();
	if (home === undefined) {
		console.error(
			"Neither PI_HOME_REALM nor MYCELIUM_REALM names a realm, so home's quests can't be named.",
		);
		process.exit(2);
	}
	const report = stampQuestRealms({
		roots: machineRoots(home),
		write: process.argv.includes("--write"),
	});
	process.stdout.write(formatStamp(report));
}

if (import.meta.main) {
	await main();
}
