/**
 * Sweep ended sessions' trees once, in a process of its own, as a user
 * timer does every hour: the sweep each pi host otherwise runs on its one
 * thread, whose git calls and folder listings held a host's thread for up
 * to 262 s on 19 November, freezing every conversation in it.
 *
 * Once a sweep has run to its end, it stamps that beside the sweep's
 * lock, naming the providers whose trees it judged, and while that stamp
 * is under two hours old a host whose providers it names stands its own
 * sweeps down. A run that fails, or finds another sweep running, leaves
 * the stamp as it was, so a timer that stops, or runs and can't sweep,
 * hands sweeping back to the hosts within two hours by itself; a failed
 * run also exits 1, so its unit shows it. It takes its turn at the same
 * lock as every other sweep, but never rests after one, as its timer
 * already spaces its runs. The lock, the stamp and the log are found by
 * the same XDG folders as the hosts', so its timer sets none of them.
 *
 * A quest's trees are read from the quests on disk, held until spent as a
 * host holds them, and a tree it takes is dropped from every live quest
 * that listed it. Its git holds to the fence's guard in every repository,
 * as a fenced session's does, since it runs in every session's trees with
 * no sandbox of its own. Git that won't run at all fails the sweep before
 * it starts, since every tree would otherwise be kept as unreadable and
 * the stamp still written.
 *
 * Providers other than git come from the modules PI_SWEEP_PROVIDERS
 * names, colon-separated, each one's default export a function giving the
 * providers to load. A module that won't load is said on stderr and
 * passed over, so the stamp doesn't name its providers and the hosts go
 * on sweeping their trees. Trees from a provider loaded nowhere here are
 * kept.
 *
 * Node runs it as it stands, stripping the types:
 *
 *   PI_SWEEP_PROVIDERS=/path/to/providers.ts node scripts/pi-sweep.ts
 */

import { pathToFileURL } from "node:url";
import {
	forgetTrees,
	liveQuestTrees,
} from "../extensions/quest-workflow/claims.ts";
import { questsRootNow } from "../extensions/quest-workflow/config.ts";
import {
	judgedProviders,
	logSweep,
	type SweepEnd,
	sweepAndLog,
	sweepLockPath,
} from "../extensions/work-integration/sweep.ts";
import {
	isTreeProvider,
	registerTreeProvider,
} from "../lib/core/work/register.ts";
import { markSweptOutside } from "../lib/core/work/sweep-rest.ts";
import { unattendedExec } from "../lib/internal/sandbox/unattended-exec.ts";

/** The setting that names the modules giving providers other than git. */
const PROVIDER_MODULES = "PI_SWEEP_PROVIDERS";

/**
 * One sweep outside every host, saying how it ended: providers loaded
 * from the modules `env` names, git checked, then the sweep, stamped for
 * the hosts only when it ran to its end.
 */
export async function sweepOutside(
	env: NodeJS.ProcessEnv = process.env,
): Promise<SweepEnd> {
	await loadProviders(env[PROVIDER_MODULES]);
	const git = await unattendedExec()("git", ["--version"]);
	if (git.code !== 0) {
		const why = git.stderr.trim() || `exit ${git.code}`;
		logSweep({ ms: 0, failed: `git won't run: ${why}` });
		return "failed";
	}
	const questsRoot = await questsRootNow();
	const end = await sweepAndLog({
		claimed: () => ({ held: [], untilSpent: liveQuestTrees(questsRoot) }),
		swept: (paths) => forgetTrees(questsRoot, paths),
		fencedGit: true,
	});
	if (end === "ran") {
		markSweptOutside(sweepLockPath(), Date.now(), judgedProviders());
	}
	return end;
}

/** Register the providers each module in `modules`, colon-separated, gives. */
async function loadProviders(modules: string | undefined): Promise<void> {
	for (const path of (modules ?? "").split(":")) {
		if (path === "") continue;
		try {
			const loaded: unknown = await import(pathToFileURL(path).href);
			const give = (loaded as { default?: unknown }).default;
			if (typeof give !== "function") {
				throw new Error("its default export gives no providers");
			}
			const given: unknown = await give();
			if (!Array.isArray(given)) {
				throw new Error("its default export gave no list of providers");
			}
			for (const provider of given) {
				if (!isTreeProvider(provider)) {
					throw new Error("it gave something that is no tree provider");
				}
			}
			for (const provider of given) registerTreeProvider(provider);
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			process.stderr.write(`pi-sweep: passed over ${path}: ${why}\n`);
		}
	}
}

if (import.meta.main && (await sweepOutside()) === "failed")
	process.exitCode = 1;
