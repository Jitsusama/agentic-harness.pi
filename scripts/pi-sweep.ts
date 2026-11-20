/**
 * Sweep ended sessions' trees once, in a process of its own, as a user
 * timer does every hour: the sweep each pi host otherwise runs on its one
 * thread, whose git calls and folder listings held a host's thread for up
 * to 262 s on 19 November, freezing every conversation in it.
 *
 * It stamps that it is sweeping before anything else, and again as it
 * ends, however it ends, since its timer counts the hour to the next run
 * from there; while that stamp is under two hours old the hosts' own
 * sweeps stand down, so a timer that stops hands sweeping back to them
 * by itself. It takes its
 * turn at the same lock as every other sweep, but never rests after one,
 * as its timer already spaces its runs. A quest's trees are read from
 * the quests on disk, held until spent as a host holds them, and a tree
 * it takes is dropped from every live quest that listed it. Trees from a
 * provider a host loads, rather than git, are kept, since no provider is
 * loaded here. It writes one line to the sweep's log, as a host's does.
 *
 * Node runs it as it stands, stripping the types:
 *
 *   node scripts/pi-sweep.ts
 */

import {
	forgetTrees,
	liveQuestTrees,
} from "../extensions/quest-workflow/claims.ts";
import { questsRootNow } from "../extensions/quest-workflow/config.ts";
import {
	sweepAndLog,
	sweepLockPath,
} from "../extensions/work-integration/sweep.ts";
import { markSweptOutside } from "../lib/core/work/sweep-rest.ts";

markSweptOutside(sweepLockPath(), Date.now());
try {
	const questsRoot = await questsRootNow();
	await sweepAndLog({
		claimed: () => ({ held: [], untilSpent: liveQuestTrees(questsRoot) }),
		swept: (paths) => forgetTrees(questsRoot, paths),
	});
} finally {
	markSweptOutside(sweepLockPath(), Date.now());
}
