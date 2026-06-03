import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearPersonResolvers,
	getPersonResolver,
	getResolutionFallback,
	listPersonResolvers,
	type PersonResolver,
	registerBuiltinPersonResolvers,
	registerPersonResolver,
	resolveIdentity,
	setResolutionFallback,
	unregisterPersonResolver,
} from "../../../lib/people";

beforeEach(() => {
	clearPersonResolvers();
	setResolutionFallback("warn");
});
afterEach(() => clearPersonResolvers());

describe("registration", () => {
	it("registers and looks up by id", () => {
		const r: PersonResolver = {
			id: "fake",
			async resolve() {
				return undefined;
			},
		};
		registerPersonResolver(r);
		expect(getPersonResolver("fake")).toBe(r);
		expect(listPersonResolvers()).toEqual([r]);
	});

	it("sorts by priority ascending", () => {
		const low: PersonResolver = {
			id: "low",
			priority: 50,
			async resolve() {
				return undefined;
			},
		};
		const high: PersonResolver = {
			id: "high",
			priority: 100,
			async resolve() {
				return undefined;
			},
		};
		registerPersonResolver(high);
		registerPersonResolver(low);
		expect(listPersonResolvers().map((r) => r.id)).toEqual(["low", "high"]);
	});

	it("unregister removes one resolver", () => {
		registerPersonResolver({
			id: "fake",
			async resolve() {
				return undefined;
			},
		});
		unregisterPersonResolver("fake");
		expect(getPersonResolver("fake")).toBeUndefined();
	});

	it("registerBuiltinPersonResolvers seeds the slack resolver", () => {
		registerBuiltinPersonResolvers();
		expect(listPersonResolvers().map((r) => r.id)).toContain("slack");
	});
});

describe("resolveIdentity chain", () => {
	it("returns the first resolver's hit", async () => {
		registerPersonResolver({
			id: "first",
			priority: 10,
			async resolve(input) {
				return { id: input, names: [input], handles: [] };
			},
		});
		registerPersonResolver({
			id: "second",
			priority: 20,
			async resolve() {
				return { id: "wrong", names: ["wrong"], handles: [] };
			},
		});
		const result = await resolveIdentity("xiao");
		expect(result?.identity.id).toBe("xiao");
		expect(result?.via).toBe("first");
	});

	it("skips a resolver that returns undefined", async () => {
		registerPersonResolver({
			id: "skipper",
			priority: 10,
			async resolve() {
				return undefined;
			},
		});
		registerPersonResolver({
			id: "answerer",
			priority: 20,
			async resolve(input) {
				return { id: input, names: [input], handles: [] };
			},
		});
		const result = await resolveIdentity("joel");
		expect(result?.via).toBe("answerer");
	});

	it("swallows a thrown error and continues the chain", async () => {
		registerPersonResolver({
			id: "thrower",
			priority: 10,
			async resolve() {
				throw new Error("boom");
			},
		});
		registerPersonResolver({
			id: "answerer",
			priority: 20,
			async resolve(input) {
				return { id: input, names: [input], handles: [] };
			},
		});
		const result = await resolveIdentity("joel");
		expect(result?.via).toBe("answerer");
	});

	it("returns undefined when no resolver answers", async () => {
		registerPersonResolver({
			id: "silent",
			priority: 10,
			async resolve() {
				return undefined;
			},
		});
		expect(await resolveIdentity("x")).toBeUndefined();
	});

	it("passes options through to the resolver", async () => {
		const spy = vi.fn(async () => undefined);
		registerPersonResolver({ id: "spy", priority: 10, resolve: spy });
		await resolveIdentity("@xiao", { hint: "handle" });
		expect(spy).toHaveBeenCalledWith("@xiao", { hint: "handle" });
	});
});

describe("fallback configuration", () => {
	it("defaults to warn", () => {
		expect(getResolutionFallback()).toBe("warn");
	});

	it("set / get round-trip", () => {
		setResolutionFallback("silent");
		expect(getResolutionFallback()).toBe("silent");
		setResolutionFallback("ask");
		expect(getResolutionFallback()).toBe("ask");
	});
});
