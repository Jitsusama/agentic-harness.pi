import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryStore, Scope } from "../../../lib/memory/index.js";
import { openMemoryStore } from "../../../lib/memory/store.js";

const quest: Scope = { kind: "quest", id: "QEST-1" };
const other: Scope = { kind: "quest", id: "QEST-2" };
const global: Scope = { kind: "global" };

let store: MemoryStore;
beforeEach(async () => {
	store = await openMemoryStore(":memory:");
});
afterEach(async () => {
	await store.close();
});

describe("memory store", () => {
	it("round-trips a retained fact within its scope", async () => {
		const fact = await store.retain({
			scope: quest,
			text: "retry lives in supervisor.ts",
		});
		expect(fact.id).toBeGreaterThan(0);
		const recalled = await store.recall({ scope: quest });
		expect(recalled.map((f) => f.text)).toEqual([
			"retry lives in supervisor.ts",
		]);
	});

	it("does not recall facts from another quest's scope", async () => {
		await store.retain({ scope: quest, text: "mine" });
		await store.retain({ scope: other, text: "theirs" });
		const recalled = await store.recall({ scope: quest, includeGlobal: false });
		expect(recalled.map((f) => f.text)).toEqual(["mine"]);
	});

	it("widens recall to include global facts by default", async () => {
		await store.retain({ scope: quest, text: "scoped" });
		await store.retain({ scope: global, text: "everywhere" });
		const texts = (await store.recall({ scope: quest })).map((f) => f.text);
		expect(texts).toContain("scoped");
		expect(texts).toContain("everywhere");
	});

	it("excludes an invalidated fact from recall", async () => {
		const fact = await store.retain({ scope: quest, text: "wrong" });
		await store.invalidate(fact.id);
		expect(await store.recall({ scope: quest })).toEqual([]);
	});

	it("archives a whole scope on conclusion and stops recalling it", async () => {
		await store.retain({ scope: quest, text: "a" });
		await store.retain({ scope: quest, text: "b" });
		const affected = await store.concludeScope(quest, "archive");
		expect(affected).toBe(2);
		expect(await store.recall({ scope: quest, includeGlobal: false })).toEqual(
			[],
		);
	});

	it("bumps recall stats but keeps old facts (no age eviction)", async () => {
		const fact = await store.retain({ scope: quest, text: "durable" });
		await store.recall({ scope: quest });
		const again = await store.recall({ scope: quest });
		expect(again[0].id).toBe(fact.id);
		expect(again[0].recalledCount).toBeGreaterThanOrEqual(1);
	});
});
