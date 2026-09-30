/**
 * The chain runs by precedence unless configured, and a configured
 * chain runs exactly the ids it names.
 */

import { describe, expect, it } from "vitest";
import {
	configuredChain,
	resolveChain,
} from "../../../lib/compaction/chain.ts";
import type { CompactionProvider } from "../../../lib/compaction/index.ts";

function provider(id: string, precedence: number): CompactionProvider {
	return {
		id,
		precedence,
		followsFocus: true,
		assess: () => ({ ok: true, dollars: 0 }),
		write: async () => ({ ok: true, text: id }),
	};
}

const registered = [
	provider("pi", 1000),
	provider("conversation", 100),
	provider("selection", 200),
];

const ids = (chain: ReturnType<typeof resolveChain>) =>
	chain.providers.map((p) => p.id);

describe("the provider chain", () => {
	it("asks every registered provider, lowest precedence first, when unconfigured", () => {
		const chain = resolveChain(registered, {});
		expect(ids(chain)).toEqual(["conversation", "selection", "pi"]);
		expect(chain.unknown).toEqual([]);
	});

	it("asks exactly the configured ids, in their order, and reports one nothing registered", () => {
		const chain = resolveChain(registered, {
			PI_COMPACTION_PROVIDERS: " pi, nope ,conversation,pi",
		});
		expect(ids(chain)).toEqual(["pi", "conversation"]);
		expect(chain.unknown).toEqual(["nope"]);
	});

	it("takes the older switch as pi's summariser alone", () => {
		expect(
			ids(resolveChain(registered, { PI_COMPACTION_SUMMARY: "pi" })),
		).toEqual(["pi"]);
	});

	it("lets a configured chain win over the older switch", () => {
		expect(
			configuredChain({
				PI_COMPACTION_PROVIDERS: "conversation",
				PI_COMPACTION_SUMMARY: "pi",
			}),
		).toEqual(["conversation"]);
	});

	it("keeps the provider registered last under an id", () => {
		const replacement = provider("conversation", 5);
		const chain = resolveChain([...registered, replacement], {});
		expect(chain.providers[0]).toBe(replacement);
		expect(chain.providers).toHaveLength(3);
	});
});
