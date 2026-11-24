/**
 * What `pi-carry` carries of a quest once its steered sessions have
 * carried their own: each resting session (one nobody closed that no pi
 * runs or holds parked) without a done file yet, with the trees the work
 * broker's records say it holds, and then every tree of the quest no done
 * file names, under a done file named for the quest.
 *
 * A tree goes once: one a session's done file already names, as a
 * steered session's does, isn't carried again under another. A done
 * file whose session file the share refuses as too large, as an earlier
 * harness left one, counts as not written, so that session goes again.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import {
	carryAway,
	carryQuestTrees,
	SHARE_LARGEST_FILE,
	type TreeCarried,
	ZIPPED,
} from "./carry-away.ts";
import { doneFileOf, doneNames, readHandover, withinHome } from "./handover.ts";
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
	| { readonly kind: "done"; readonly files: readonly string[] }
	/**
	 * Every tree refused, each with its why, said once at the end, since
	 * mycelium reads only a failed line for why `pi-carry` exited 1.
	 */
	| { readonly kind: "failed"; readonly why: string };

/** What carrying the rest needs. */
export interface CarryingRest {
	readonly exec: Exec;
	/** This machine's handover folder for the quest. */
	readonly into: string;
	readonly home: string;
	readonly here: QuestHere;
	readonly say: (line: RestLine) => void;
	/**
	 * The largest session file that goes as it is, and the largest bundle
	 * or patch any tree may send; `SHARE_LARGEST_FILE` unless a test names
	 * one.
	 */
	readonly largestFile?: number;
}

/**
 * Carries what the quest's steered sessions left, ending with the done
 * files written; answers whether every tree went.
 */
export async function carryRest(carrying: CarryingRest): Promise<boolean> {
	const { exec, into, home, here, say } = carrying;
	const largest = carrying.largestFile ?? SHARE_LARGEST_FILE;
	const already = doneNames(listing(into)).filter(
		(name) => !tooLargeToShare(into, name, largest),
	);
	const handled = new Set(
		already
			.filter((name) => name !== here.quest)
			.flatMap((name) => readHandover(doneFileOf(into, name))?.trees ?? [])
			.map((tree) => tree.path),
	);
	const files: string[] = [];
	const refused: string[] = [];
	// Each tree is said once, and tried once, whatever became of it.
	const tell = (under: string, trees: readonly TreeCarried[]) => {
		for (const tree of trees) {
			if (tree.kind === "refused") refused.push(`${tree.path}: ${tree.why}`);
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
		let away: Awaited<ReturnType<typeof carryAway>>;
		try {
			away = await carryAway({
				exec,
				into,
				home,
				quest: here.quest,
				session,
				trees,
				largestFile: largest,
			});
		} catch (error) {
			// Its trees wait for it here, unhandled, so they aren't carried
			// under the quest without it.
			for (const tree of trees) handled.add(withinHome(tree, home));
			refused.push(
				`session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
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
	try {
		const quest = await carryQuestTrees(
			exec,
			left,
			into,
			home,
			here.quest,
			largest,
		);
		tell(here.quest, quest.trees);
		if (quest.file !== undefined) files.push(quest.file);
	} catch (error) {
		// Its earlier carry was put back; mycelium hears why from the failed line.
		refused.push(
			`the quest's own trees: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	say({ kind: "done", files });
	if (refused.length === 0) return true;
	say({
		kind: "failed",
		why: `${refused.length === 1 ? "one thing was" : `${refused.length} things were`} refused, so the carry isn't whole: ${refused.join("; ")}`,
	});
	return false;
}

/**
 * Whether the done file `name` names a session file left as it is that
 * is larger than the share carries, so it never reached the other side.
 */
function tooLargeToShare(into: string, name: string, largest: number): boolean {
	const file = readHandover(doneFileOf(into, name))?.sessionFile;
	if (file === undefined || file.endsWith(ZIPPED)) return false;
	try {
		return statSync(join(into, file)).size > largest;
	} catch {
		// Gone: nothing too large is left to share.
		return false;
	}
}

function listing(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		// No handover yet: nothing has been carried from here.
		return [];
	}
}
