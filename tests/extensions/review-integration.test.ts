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

import { afterEach, describe, expect, it, vi } from "vitest";
import reviewIntegration from "../../extensions/review-integration/index.js";
import {
	clearReviewProviders,
	listReviewProviders,
	REVIEW_READY,
	REVIEW_REGISTER_PROVIDER,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewSubstrateApi,
} from "../../lib/review/index.js";

/** Just enough of pi's surface for registration to run. */
function stubPi() {
	const tools: string[] = [];
	const handlers = new Map<string, (data: unknown) => void>();
	const emitted: { event: string; data: unknown }[] = [];
	const pi = {
		registerTool(definition: { name: string }) {
			tools.push(definition.name);
		},
		exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
		events: {
			on(event: string, handler: (data: unknown) => void) {
				handlers.set(event, handler);
			},
			emit(event: string, data: unknown) {
				emitted.push({ event, data });
			},
		},
	};
	return { pi, tools, handlers, emitted };
}

/** Run the extension against a stub. */
function activate() {
	const stub = stubPi();
	// The stub is structural: the extension only uses the parts
	// modelled here, and a real ExtensionAPI is unavailable
	// outside a session.
	reviewIntegration(stub.pi as never);
	return stub;
}

afterEach(() => clearReviewProviders());

describe("the review integration", () => {
	it("registers one tool per concern", () => {
		const { tools } = activate();
		expect(tools).toEqual([
			"review",
			"review_stack",
			"review_thread",
			"review_draft",
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
		const { handlers, emitted } = activate();
		const before = emitted.filter(
			(entry) => entry.event === REVIEW_READY,
		).length;

		handlers.get(REVIEW_REQUEST_SUBSTRATE)?.(undefined);

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
		const { handlers } = activate();
		handlers.get(REVIEW_REGISTER_PROVIDER)?.({
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
		const { handlers } = activate();
		const register = handlers.get(REVIEW_REGISTER_PROVIDER);
		register?.({ id: "broken" });
		register?.(undefined);
		register?.("not a provider");
		expect(listReviewProviders().map((provider) => provider.id)).toEqual([
			"github",
			"git",
		]);
	});

	it("lets a downstream provider out-claim the built-ins", () => {
		const { handlers } = activate();
		handlers.get(REVIEW_REGISTER_PROVIDER)?.({
			id: "meteorite",
			priority: 50,
			claimReference: () => null,
			claimRepo: () => null,
			capabilities: () => ({}),
		});
		expect(listReviewProviders()[0].id).toBe("meteorite");
	});
});
