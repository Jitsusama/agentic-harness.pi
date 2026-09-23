import { describe, expect, it } from "vitest";
import { pressureTriggersAdvisor } from "../../../lib/control/index.js";

describe("deciding whether a pressure reading is worth an advisor look", () => {
	it("does not trigger on a calm reading", () => {
		expect(
			pressureTriggersAdvisor({
				paybackDistance: "calm",
				costPerTurn: "calm",
				reexpansion: "calm",
				overall: "calm",
			}),
		).toBe(false);
	});

	it("does not trigger on elevated alone: elevated is a watch, not a call", () => {
		expect(
			pressureTriggersAdvisor({
				paybackDistance: "elevated",
				costPerTurn: "calm",
				reexpansion: "calm",
				overall: "elevated",
			}),
		).toBe(false);
	});

	it("triggers once the overall reading is critical", () => {
		expect(
			pressureTriggersAdvisor({
				paybackDistance: "calm",
				costPerTurn: "calm",
				reexpansion: "critical",
				overall: "critical",
			}),
		).toBe(true);
	});
});
