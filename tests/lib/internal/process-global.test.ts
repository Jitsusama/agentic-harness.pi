import { describe, expect, it } from "vitest";
import { processGlobal } from "../../../lib/internal/process-global.js";

describe("processGlobal", () => {
	it("creates the value once and returns it on later calls", () => {
		let creations = 0;
		const key = `pi:test:once:${Math.random()}`;
		const a = processGlobal(key, () => {
			creations += 1;
			return new Map<string, number>();
		});
		const b = processGlobal(key, () => {
			creations += 1;
			return new Map<string, number>();
		});
		expect(a).toBe(b);
		expect(creations).toBe(1);
	});

	it("shares mutations through the same instance", () => {
		const key = `pi:test:shared:${Math.random()}`;
		const first = processGlobal(key, () => new Set<string>());
		first.add("x");
		const second = processGlobal(key, () => new Set<string>());
		expect(second.has("x")).toBe(true);
	});

	it("keeps distinct keys independent", () => {
		const a = processGlobal(`pi:test:a:${Math.random()}`, () => ({ n: 1 }));
		const b = processGlobal(`pi:test:b:${Math.random()}`, () => ({ n: 2 }));
		expect(a).not.toBe(b);
		expect(a.n).toBe(1);
		expect(b.n).toBe(2);
	});
});
