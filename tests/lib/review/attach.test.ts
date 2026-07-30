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
		// It falls through to recency rather than to a refusal: a stale hint
		// is no reason to stop working.
		const chosen = changeInPlay(undefined, "Shopify/world#9", [
			"Shopify/world#1",
			"Shopify/world#2",
		]);

		expect(chosen).toMatchObject({ label: "Shopify/world#1" });
	});

	it("takes the most recently attached change, and says so", () => {
		// This used to refuse, and refusing was worse than the risk it was
		// avoiding: a second attachment paralysed every tool and the only way
		// out was to detach something. Attaching a change is how a person
		// says what they are working on now, so the newest wins.
		const chosen = changeInPlay(undefined, undefined, ["a#1", "b#2"]);

		expect(chosen).toMatchObject({ label: "a#1" });
	});

	it("names the ones it passed over, and how to reach them", () => {
		// The objection to choosing was silence, not choice. Somebody who
		// meant the other one has to learn that from the answer.
		const chosen = changeInPlay(undefined, undefined, ["a#1", "b#2", "c#3"]);

		const note = "note" in chosen ? chosen.note : undefined;
		expect(note).toContain("b#2, c#3");
		expect(note).toContain("Name a change");
	});

	it("still refuses when nothing is attached at all", () => {
		// The one case with no answer to give.
		const chosen = changeInPlay(undefined, undefined, []);

		expect(chosen).toEqual({ candidates: [] });
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
