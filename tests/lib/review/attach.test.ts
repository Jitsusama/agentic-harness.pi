import { describe, expect, it } from "vitest";
import { changeInPlay, chooseChange } from "../../../lib/review/attach.js";

describe("changeInPlay", () => {
	it("never second-guesses a change the caller named", () => {
		const chosen = changeInPlay("Shopify/world#7", undefined, [
			"Shopify/world#1",
		]);

		expect(chosen).toEqual({ label: "Shopify/world#7" });
	});

	it("uses the only attached change and says which", () => {
		const chosen = changeInPlay(undefined, undefined, ["Shopify/world#1"]);

		expect(chosen).toMatchObject({ label: "Shopify/world#1" });
		expect("note" in chosen && chosen.note).toContain("Shopify/world#1");
	});

	it("prefers the hinted change when several are attached", () => {
		const chosen = changeInPlay(undefined, "Shopify/world#2", [
			"Shopify/world#1",
			"Shopify/world#2",
		]);

		expect(chosen).toEqual({ label: "Shopify/world#2" });
	});

	it("ignores a hint that is not attached", () => {
		const chosen = changeInPlay(undefined, "Shopify/world#9", [
			"Shopify/world#1",
			"Shopify/world#2",
		]);

		expect(chosen).toEqual({
			candidates: ["Shopify/world#1", "Shopify/world#2"],
		});
	});

	it("refuses to choose between several attached changes", () => {
		const chosen = changeInPlay(undefined, undefined, ["a#1", "b#2"]);

		expect(chosen).toEqual({ candidates: ["a#1", "b#2"] });
	});

	it("reports nothing attached as an empty choice rather than a pick", () => {
		const chosen = changeInPlay(undefined, undefined, []);

		expect(chosen).toEqual({ candidates: [] });
	});
});

describe("chooseChange", () => {
	it("says how to attach one when nothing is attached", () => {
		const text = chooseChange([]);

		expect(text).toContain("review attach");
	});

	it("lists the changes to choose between and says why it will not", () => {
		const text = chooseChange(["Shopify/world#1", "Shopify/world#2"]);

		expect(text).toContain("Shopify/world#1");
		expect(text).toContain("Shopify/world#2");
		expect(text.toLowerCase()).toContain("wrong change");
	});
});
