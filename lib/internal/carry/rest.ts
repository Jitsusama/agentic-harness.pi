/**
 * What `pi-carry` carries of a quest once its steered sessions have
 * carried their own: each resting session (one nobody closed that no pi
 * runs or holds parked) without a done file yet, with the trees the work
 * broker's records say it holds, and then every tree of the quest no done
 * file names, under a done file named for the quest.
 *
 * A tree goes once: one a session's done file already names, as a
 * steered session's does, isn't carried again under another.
 */

import { readdirSync } from "node:fs";
import type { Exec } from "../../core/exec/index.ts";
import { carryAway, carryTrees, type TreeCarried } from "./carry-away.ts";
import {
	doneFileOf,
	doneNames,
	readHandover,
	withinHome,
	writeHandover,
} from "./handover.ts";
import type { QuestHere } from "./quest-here.ts";

/** One line carrying the rest says, as `pi-carry` prints it. */
export type RestLine =
	| {
			readonly kind: "tree";
			/** The done file's name: a session's id, or the quest's. */
			readonly under: string;
			readonly path: string;
			readonly did: TreeCarried["kind"];
			readonly why?: string;
	  }
	| { readonly kind: "done"; readonly files: readonly string[] };

/** What carrying the rest needs. */
export interface CarryingRest {
	readonly exec: Exec;
	/** This machine's handover folder for the quest. */
	readonly into: string;
	readonly home: string;
	readonly here: QuestHere;
	readonly say: (line: RestLine) => void;
}

/**
 * Carries what the quest's steered sessions left, ending with the done
 * files written; answers whether every tree went.
 */
export async function carryRest(carrying: CarryingRest): Promise<boolean> {
	const { exec, into, home, here, say } = carrying;
	const already = doneNames(listing(into));
	const handled = new Set(
		already
			.filter((name) => name !== here.quest)
			.flatMap((name) => readHandover(doneFileOf(into, name))?.trees ?? [])
			.map((tree) => tree.path),
	);
	const files: string[] = [];
	let whole = true;
	// Each tree is said once, and tried once, whatever became of it.
	const tell = (under: string, trees: readonly TreeCarried[]) => {
		for (const tree of trees) {
			if (tree.kind === "refused") whole = false;
			handled.add(withinHome(tree.path, home));
			say({
				kind: "tree",
				under,
				path: tree.path,
				did: tree.kind,
				...(tree.kind === "carried" ? {} : { why: tree.why }),
			});
		}
	};
	const unhandled = (path: string) => !handled.has(withinHome(path, home));
	for (const session of here.resting) {
		if (already.includes(session.id)) continue;
		const trees = here.held
			.filter((tree) => tree.sessions.includes(session.id))
			.map((tree) => tree.path)
			.filter(unhandled);
		const away = await carryAway({
			exec,
			into,
			home,
			quest: here.quest,
			session,
			trees,
		});
		files.push(away.file);
		tell(session.id, away.trees);
	}
	const left = [
		...new Set([
			...here.trees,
			...here.held
				.filter((tree) => tree.sessions.some((one) => here.sessions.has(one)))
				.map((tree) => tree.path),
		]),
	].filter(unhandled);
	const trees = await carryTrees(exec, left, into, home);
	tell(here.quest, trees);
	const handed = trees.flatMap((one) =>
		one.kind === "carried" ? [one.tree] : [],
	);
	// A done file of no trees and no session would start nothing there.
	if (handed.length > 0) {
		files.push(
			writeHandover(into, {
				session: here.quest,
				quest: here.quest,
				cwd: "~",
				trees: handed,
			}),
		);
	}
	say({ kind: "done", files });
	return whole;
}

function listing(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		// No handover yet: nothing has been carried from here.
		return [];
	}
}
