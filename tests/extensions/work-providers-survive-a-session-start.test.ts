/**
 * A provider from another package survives the host resetting itself.
 *
 * The working layer's registry is process-global and takes providers
 * over the bus, so a package that never imports this one can put a tree
 * provider into it. The host clears that registry at session start and
 * re-registers only its own built-ins, which deletes everybody else's.
 *
 * That was harmless for exactly as long as the handler never ran. It was
 * registered on the event bus, which carries no lifecycle event, so it
 * sat dead from the day it was written; moving it to pi's lifecycle API
 * is what makes the question real, and nothing in this suite activated
 * the extension either way.
 *
 * The contract says how it is meant to work: the host announces a live
 * registry, and a provider re-registers on hearing it. Anything else
 * leaves a third-party provider's survival to the order two extensions
 * happened to load in, which is the one thing the bus exists to stop
 * mattering.
 */

import {
	WORK_READY,
	WORK_REGISTER_TREE_PROVIDER,
} from "@jitsusama/agentic-harness.core/work";
import { describe, expect, it } from "vitest";
import workIntegration from "../../extensions/work-integration/index.js";
import { activateWith } from "./support/review-extension.js";

/** A tree provider from a package that knows nothing about this one. */
const ELSEWHERE = {
	id: "somewhere-else",
	specificity: 10,
	appliesTo: () => false,
	ensure: async () => {
		throw new Error("never called");
	},
	release: async () => {
		throw new Error("never called");
	},
};

describe("the working layer's registry", () => {
	it("still holds an outside provider after a session starts", () => {
		const stub = activateWith(workIntegration);

		// How a provider in another package registers: it hears the
		// host announce itself, and registers again each time it does.
		stub.pi.events.on(WORK_READY, () => {
			stub.pi.events.emit(WORK_REGISTER_TREE_PROVIDER, ELSEWHERE);
		});
		stub.pi.events.emit(WORK_REGISTER_TREE_PROVIDER, ELSEWHERE);

		const started = stub.lifecycle.get("session_start");
		if (started === undefined) {
			throw new Error("work-integration registered no session_start");
		}
		started({ reason: "startup" }, {});

		const announcements = stub.emitted.filter(
			(entry) => entry.event === WORK_READY,
		);
		const api = announcements[announcements.length - 1]?.data as {
			listTreeProviders(): string[];
		};
		expect(api.listTreeProviders()).toContain("somewhere-else");
	});
});
