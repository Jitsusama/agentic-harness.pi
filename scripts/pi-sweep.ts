/**
 * Sweep ended sessions' trees once, in a process of its own, as a user
 * timer does every hour: the sweep each pi host otherwise runs on its one
 * thread, whose git calls and folder listings held a host's thread for up
 * to 262 s on 19 November, freezing every conversation in it.
 *
 * Once a sweep has run to its end, it stamps that beside the sweep's
 * lock, and while that stamp is under two hours old the hosts' own sweeps
 * stand down. A run that fails, or finds another sweep running, leaves
 * the stamp as it was, so a timer that stops, or runs and can't sweep,
 * hands sweeping back to the hosts within two hours by itself. It takes
 * its turn at the same lock as every other sweep, but never rests after
 * one, as its timer already spaces its runs. The lock, the stamp and the
 * log are found by the same XDG folders as the hosts', so its timer sets
 * none of them.
 *
 * A quest's trees are read from the quests on disk, held until spent as a
 * host holds them, and a tree it takes is dropped from every live quest
 * that listed it. Its git holds to the fence's guard in every repository,
 * as a fenced session's does, since it runs in every session's trees with
 * no sandbox of its own. Trees from a provider a host loads, rather than
 * git, are kept, since no provider is loaded here. It writes one line to
 * the sweep's log, as a host's does.
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

const questsRoot = await questsRootNow();
const ran = await sweepAndLog({
	claimed: () => ({ held: [], untilSpent: liveQuestTrees(questsRoot) }),
	swept: (paths) => forgetTrees(questsRoot, paths),
	fencedGit: true,
});
if (ran) markSweptOutside(sweepLockPath(), Date.now());
