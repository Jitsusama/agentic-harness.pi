/**
 * Work Integration Extension
 *
 * Hosts the working layer: owns the tree provider registry for a
 * session, registers the plain-git provider this package ships,
 * and exposes the `work` tool. Takes back, a while after a session
 * starts and hourly, the trees whose sessions have all ended.
 *
 * Providers register over the event bus rather than by importing
 * the registry, so a specialised one can live in another package
 * entirely. World's `dev tree` is the motivating case: it knows
 * how to cut a tree from a monorepo nobody wants a plain worktree
 * of, and it has no business being in this package. The handshake
 * runs both ways, as the review substrate's does, so neither
 * load order matters.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TreeProvider } from "../../lib/core/work/broker.ts";
import {
	WORK_READY,
	WORK_REGISTER_TREE_PROVIDER,
	WORK_REQUEST,
	type WorkApi,
} from "../../lib/core/work/events.ts";
import {
	clearTreeProviders,
	isTreeProvider,
	listTreeProviders,
	registerTreeProvider,
} from "../../lib/core/work/register.ts";
import { isAgentCut } from "../../lib/internal/work-records.ts";
import {
	forgetTreeBroker,
	registerBuiltinTreeProviders,
	reownSessionTrees,
	treeBroker,
	treesHeldBySession,
} from "./broker.ts";
import { registerTreeSweeps } from "./sweep.ts";
import { registerWorkTool } from "./tools.ts";

export default function workIntegration(pi: ExtensionAPI) {
	registerBuiltinTreeProviders(pi);

	registerWorkTool(pi);

	registerTreeSweeps(pi);

	// A tree the work tool cut is trusted without asking, as Joel ruled on
	// 8 November: an agent made it for its own work, and pi's folder-trust
	// prompt stopped three spawned sessions' notes at 20:20 the day before.
	// Only for this process, so no decision is saved for a folder that goes.
	pi.on("project_trust", async (event) =>
		isAgentCut(event.cwd)
			? { trusted: "yes" as const, remember: false }
			: { trusted: "undecided" as const },
	);

	const api: WorkApi = {
		registerTreeProvider(provider: TreeProvider) {
			registerTreeProvider(provider);
		},
		listTreeProviders() {
			return listTreeProviders().map((provider) => provider.id);
		},
		broker() {
			return treeBroker();
		},
	};

	pi.events.on(WORK_REGISTER_TREE_PROVIDER, (data: unknown) => {
		if (isTreeProvider(data)) registerTreeProvider(data);
	});
	// A consumer that loaded after this extension missed the
	// announcement, and the bus does not replay. Asking is how it
	// catches up, so load order decides nothing.
	pi.events.on(WORK_REQUEST, () => {
		pi.events.emit(WORK_READY, api);
	});
	pi.events.emit(WORK_READY, api);

	// On pi's lifecycle API, not the bus. The bus is for extensions to
	// talk to each other and pi publishes no lifecycle event onto it, so
	// this handler sat there and never ran once, and the guarantee the
	// comment below states was not being provided at all.
	pi.on("session_start", (_event, ctx) => {
		// Each tree taken up from here on names the session as well as the
		// process, so a session resumed after a restart keeps its trees.
		const id = ctx?.sessionManager?.getSessionId?.();
		void treesHeldBySession(id);
		// And the trees it already holds name the process it runs in now,
		// since after a restart their records still name the old one. Not
		// awaited: the record folder is listed off the thread, only the
		// session's own records are read on it, and the start never waits
		// on a lock or a rewrite.
		if (id !== undefined) {
			void reownSessionTrees(id).catch((error: unknown) =>
				sayReownFailed(id, error),
			);
		}
		// A new session must not inherit the last one's providers or
		// its broker: the trees on disk outlive the session, but which
		// provider would be chosen for one is a question of the
		// configuration now loaded.
		clearTreeProviders();
		forgetTreeBroker(id);
		registerBuiltinTreeProviders(pi);
		// Then say so, because the registry just emptied held providers
		// from other packages and only the built-in ones came back. The
		// contract in lib/work/events.ts is that the host announces a
		// live registry and a provider re-registers on hearing it; a
		// clear without an announcement deletes a third-party provider
		// for the life of the process, and leaves whether it survives
		// to the order two extensions happen to load in, which is the
		// one thing the bus exists to stop mattering.
		pi.events.emit(WORK_READY, api);
	});
}

/**
 * Say on stderr, which a host's journal keeps, that a session's trees
 * still name the process it ran in before. Their records keep the old
 * owner and the next start tries again, but meanwhile the sweep may
 * judge them abandoned, so a failure here must not pass without a word.
 */
function sayReownFailed(id: string, error: unknown): void {
	const why = error instanceof Error ? error.message : String(error);
	process.stderr.write(
		`work-integration: the trees session ${id} holds still name the process it ran in before, since re-owning them failed: ${why}. The next start tries again.\n`,
	);
}
