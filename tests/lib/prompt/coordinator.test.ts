import { afterEach, describe, expect, it } from "vitest";
import {
	clearPromptContributors,
	createFrozenResidentPrompt,
	registerPromptContributor,
} from "../../../lib/prompt/coordinator.js";

const ctx = { cwd: "/tmp" } as never;

afterEach(() => clearPromptContributors());

describe("createFrozenResidentPrompt", () => {
	it("composes contributors deterministically by order, not registration order", async () => {
		registerPromptContributor({
			id: "b",
			order: 20,
			contribute: () => "SECOND",
		});
		registerPromptContributor({
			id: "a",
			order: 10,
			contribute: () => "FIRST",
		});
		const block = await createFrozenResidentPrompt().assemble(ctx);
		expect(block).toBe("FIRST\n\nSECOND");
	});

	it("skips contributors that return nothing", async () => {
		registerPromptContributor({ id: "a", order: 10, contribute: () => "KEEP" });
		registerPromptContributor({
			id: "b",
			order: 20,
			contribute: () => undefined,
		});
		expect(await createFrozenResidentPrompt().assemble(ctx)).toBe("KEEP");
	});

	it("freezes: a later change to a contributor does not change the output", async () => {
		let text = "ONE";
		registerPromptContributor({ id: "a", order: 10, contribute: () => text });
		const frozen = createFrozenResidentPrompt();
		const first = await frozen.assemble(ctx);
		text = "TWO";
		const second = await frozen.assemble(ctx);
		expect(first).toBe("ONE");
		expect(second).toBe("ONE");
	});

	it("returns an empty string when no contributor produces text", async () => {
		expect(await createFrozenResidentPrompt().assemble(ctx)).toBe("");
	});
});
