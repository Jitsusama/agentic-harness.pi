/**
 * The extension's wiring, checked without a pi session.
 *
 * Most extension wiring is left to a live session, because it
 * leans on pi's runtime. This much does not: which tools exist,
 * that the bus handshake runs both ways, and that a malformed
 * registration is ignored rather than corrupting the registry.
 * Those are exactly the mistakes that are invisible until
 * someone tries to use the thing.
 */

import {
	clearReviewProviders,
	listReviewProviders,
	REVIEW_READY,
	REVIEW_REGISTER_PROVIDER,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewSubstrateApi,
} from "@jitsusama/agentic-harness.core/review";
import { afterEach, describe, expect, it } from "vitest";
import { watchRound } from "../../extensions/review-integration/progress.js";
import { activate } from "./support/review-extension.js";

afterEach(() => clearReviewProviders());

describe("the review integration", () => {
	it("survives a session with no UI to draw on", () => {
		// The reporter must never take a round down. A headless session has
		// no terminal to draw in, and a round asked in one has to run
		// exactly as it would with one.
		//
		// This used to reach for a session_start handler that stashed the
		// context, and it asserted through an optional call, so when that
		// handler went away the test kept passing while checking nothing.
		// The context now arrives as an argument to the tool's execute, so
		// the thing to exercise is the reporter itself.
		const watch = watchRound("council", { hasUI: false } as never);

		expect(() => {
			watch.progress.start([{ id: "one" }] as never);
			watch.progress.started("one");
			watch.progress.activity("one", "reading a file");
			watch.progress.answered("one");
			watch.progress.recorded("one", 2);
			watch.progress.finish();
		}).not.toThrow();
	});

	it("still cancels with no UI, since the signal is not the panel", () => {
		// Otherwise a headless caller would have no way to stop a round at
		// all, which is the case that matters most: nobody is watching.
		const outer = new AbortController();
		const watch = watchRound("council", null, outer.signal);
		const one = watch.signalFor("one");

		outer.abort();

		expect(one.aborted).toBe(true);
	});

	it("registers one tool per intent, not one per subject", () => {
		const { tools } = activate();
		expect(tools).toEqual([
			"review",
			"review_see",
			"review_say",
			"review_ask",
			"review_draft",
			"review_offer",
		]);
	});

	it("registers the providers this package ships", () => {
		activate();
		expect(listReviewProviders().map((provider) => provider.id)).toEqual([
			"github",
			"git",
		]);
	});

	it("announces that the registry is open", () => {
		const { emitted } = activate();
		const ready = emitted.find((entry) => entry.event === REVIEW_READY);
		expect(ready).toBeTruthy();
		const api = ready?.data as ReviewSubstrateApi;
		expect(api.listProviders()).toContain("github");
	});

	it("announces itself again when a latecomer asks", () => {
		// The bus does not replay, so a consumer that activated
		// after the host missed the first announcement entirely.
		// Without a way to ask, load order decides whether the
		// substrate is reachable at all.
		const { fire, emitted } = activate();
		const before = emitted.filter(
			(entry) => entry.event === REVIEW_READY,
		).length;

		fire(REVIEW_REQUEST_SUBSTRATE, undefined);

		const after = emitted.filter((entry) => entry.event === REVIEW_READY);
		expect(after).toHaveLength(before + 1);
		const answered = after.at(-1)?.data as ReviewSubstrateApi | undefined;
		expect(answered?.listProviders()).toContain("github");
	});

	it("hands over an engine, so a consumer resolves through this registry", async () => {
		// A consumer that built its own engine would see only the
		// built-in providers, and a downstream provider that
		// registered over the bus would be invisible to it.
		const { emitted } = activate();
		const api = emitted.find((entry) => entry.event === REVIEW_READY)
			?.data as ReviewSubstrateApi;

		expect(typeof api.engine).toBe("function");
		const engine = await api.engine();
		expect(typeof engine.resolve).toBe("function");
		expect(typeof engine.probe).toBe("function");
	});

	it("accepts a provider that arrives over the bus", () => {
		const { fire } = activate();
		fire(REVIEW_REGISTER_PROVIDER, {
			id: "meteorite",
			priority: 50,
			claimReference: () => null,
			claimRepo: () => null,
			capabilities: () => ({}),
		});
		expect(listReviewProviders().map((provider) => provider.id)).toEqual([
			"meteorite",
			"github",
			"git",
		]);
	});

	it("ignores a malformed registration rather than storing it", () => {
		const { fire } = activate();
		fire(REVIEW_REGISTER_PROVIDER, { id: "broken" });
		fire(REVIEW_REGISTER_PROVIDER, undefined);
		fire(REVIEW_REGISTER_PROVIDER, "not a provider");
		expect(listReviewProviders().map((provider) => provider.id)).toEqual([
			"github",
			"git",
		]);
	});

	it("lets a downstream provider out-claim the built-ins", () => {
		const { fire } = activate();
		fire(REVIEW_REGISTER_PROVIDER, {
			id: "meteorite",
			priority: 50,
			claimReference: () => null,
			claimRepo: () => null,
			capabilities: () => ({}),
		});
		expect(listReviewProviders()[0].id).toBe("meteorite");
	});
});
