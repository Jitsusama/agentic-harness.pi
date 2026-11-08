import { describe, expect, it } from "vitest";
import {
	type TrustFacts,
	trustPromptWaits,
} from "../../../extensions/quest-workflow/trust-prompt.ts";

/** A folder trust gates, nobody has decided on, under pi's default. */
const untrusted: TrustFacts = {
	gated: () => true,
	saved: () => null,
	byDefault: () => "ask",
};

describe("whether pi's folder-trust prompt waits", () => {
	it("waits in a gated folder nobody has decided on", () => {
		expect(trustPromptWaits("/tree", "pi", untrusted)).toBe(true);
	});

	it("doesn't wait once a decision is saved, either way", () => {
		for (const decision of [true, false]) {
			expect(
				trustPromptWaits("/tree", "pi", {
					...untrusted,
					saved: () => decision,
				}),
			).toBe(false);
		}
	});

	it("doesn't wait in a folder with nothing trust gates", () => {
		expect(
			trustPromptWaits("/tree", "pi", { ...untrusted, gated: () => false }),
		).toBe(false);
	});

	it("doesn't wait where the default setting decides", () => {
		for (const setting of ["always", "never"]) {
			expect(
				trustPromptWaits("/tree", "pi", {
					...untrusted,
					byDefault: () => setting,
				}),
			).toBe(false);
		}
	});

	it("doesn't wait when the command decides for itself", () => {
		for (const flag of ["--approve", "-a", "--no-approve", "-na"]) {
			expect(trustPromptWaits("/tree", `pi ${flag} --model m`, untrusted)).toBe(
				false,
			);
		}
	});

	it("says nothing about a folder it can't read", () => {
		const unreadable: TrustFacts = {
			...untrusted,
			gated: () => {
				throw new Error("EACCES: /tree");
			},
		};

		expect(trustPromptWaits("/tree", "pi", unreadable)).toBe(false);
	});
});
