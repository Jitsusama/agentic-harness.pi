/**
 * The `work` tool's carry action: a tree's work and this session, put
 * where its quest's share takes them home.
 *
 * A session on a machine that is leaving, and may not push where its work
 * belongs, carries it instead. The tree's unpushed commits go into a
 * bundle, and this session's file goes beside them with what Restore
 * needs, in the quest's scratch under `handover/<this machine>/`. That
 * folder crosses wherever the machine sharing the quest named it, with
 * `mycelium share QUEST --scratch handover`.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Exec } from "../../../lib/core/exec/index.ts";
import {
	carrySession,
	carryTree,
	type HeldTree,
} from "../../../lib/core/work/index.ts";
import { questLoadedIn } from "../../../lib/internal/quest/loaded.ts";
import { questWorkspacesRoot } from "../../../lib/internal/quest/workspace-root.ts";
import { count } from "../../../lib/ui/index.ts";
import { GLYPH } from "../render.ts";
import { type Answer, refuse, say } from "./shared.ts";

/** The folder of the quest's scratch the share carries a handover in. */
export const HANDOVER = "handover";

/** Carries the work in `found`, and this session, into the quest's handover. */
export async function carryHome(
	exec: Exec,
	found: HeldTree,
	sessions: ExtensionContext["sessionManager"],
): Promise<Answer> {
	const sessionId = sessions.getSessionId();
	const quest = await questLoadedIn(sessionId);
	if (quest === undefined) {
		return refuse(
			`${GLYPH.refused} No quest is loaded, and a handover goes home in its quest's scratch. Load the quest first.`,
		);
	}
	const into = join(questWorkspacesRoot(), quest, HANDOVER, hostname());
	const name = found.identity.key.replace(/[^A-Za-z0-9._-]/g, "-");
	const tree = await carryTree(exec, found.path, into, name);
	if (tree.kind === "refused") {
		return refuse(`${GLYPH.refused} ${tree.reason}`);
	}
	const file = sessions.getSessionFile();
	const session =
		file === undefined
			? undefined
			: carrySession(file, join(into, "sessions"), {
					id: sessionId,
					cwd: sessions.getCwd(),
					quest,
					...(sessions.getSessionName()
						? { title: sessions.getSessionName() }
						: {}),
				});
	const left = tree.kind === "carried" ? tree.carried.left : tree.left;
	const lines = [
		tree.kind === "carried"
			? `${GLYPH.tree} ${tree.carried.branch}'s ${count(tree.carried.commits, "unpushed commit")} bundled in ${tree.carried.bundle}.`
			: `${GLYPH.clean} ${tree.branch} has nothing a remote lacks, so no bundle was needed.`,
		...(left.length === 0
			? []
			: [
					`   ${GLYPH.dirty} ${count(left.length, "file")} not committed stay here: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ", and more" : ""}. Record them and carry again to take them.`,
				]),
		session === undefined
			? "   This session keeps no file, so it isn't carried."
			: "   This session's file is beside it, as it stands now; later turns aren't in it.",
		`   Written to ${into}, which reaches home where ${quest}'s ${HANDOVER} scratch folder is shared.`,
	];
	return say(lines.join("\n"), {
		ok: true,
		into,
		carried: tree.kind === "carried",
		left,
		...(session === undefined ? {} : { session }),
	});
}
