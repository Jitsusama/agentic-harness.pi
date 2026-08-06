/**
 * Work Integration Extension
 *
 * Hosts the working layer: owns the tree provider registry for a
 * session, registers the plain-git provider this package ships,
 * and exposes the `work` tool.
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
import {
	clearTreeProviders,
	listTreeProviders,
	registerTreeProvider,
	type TreeProvider,
	WORK_READY,
	WORK_REGISTER_TREE_PROVIDER,
	WORK_REQUEST,
	type WorkApi,
} from "../../lib/work/index.js";
import {
	forgetTreeBroker,
	registerBuiltinTreeProviders,
	treeBroker,
} from "./broker.js";
import { registerWorkTool } from "./tools.js";

/**
 * Whether a bus payload is a usable tree provider. The bus is
 * untyped, and a malformed registration should be ignored rather
 * than corrupting the registry.
 */
function isTreeProvider(data: unknown): data is TreeProvider {
	if (typeof data !== "object" || data === null) return false;
	const candidate = data as Partial<TreeProvider>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.specificity === "number" &&
		typeof candidate.appliesTo === "function" &&
		typeof candidate.ensure === "function" &&
		typeof candidate.release === "function"
	);
}

export default function workIntegration(pi: ExtensionAPI) {
	registerBuiltinTreeProviders(pi);

	registerWorkTool(pi);

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
	pi.on("session_start", () => {
		// A new session must not inherit the last one's providers or
		// its broker: the trees on disk outlive the session, but which
		// provider would be chosen for one is a question of the
		// configuration now loaded.
		clearTreeProviders();
		forgetTreeBroker();
		registerBuiltinTreeProviders(pi);
	});
}
