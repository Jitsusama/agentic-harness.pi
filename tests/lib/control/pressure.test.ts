import { describe, expect, it } from "vitest";
import { readPressure } from "../../../lib/control/index.ts";

describe("reading pressure across the three bands", () => {
	it("reads calm when every input is comfortably inside its band", () => {
		const reading = readPressure({
			paybackMargin: 5,
			costPerTurnRatio: 1,
			reexpansionRate: 0,
		});
		expect(reading.paybackDistance).toBe("calm");
		expect(reading.costPerTurn).toBe("calm");
		expect(reading.reexpansion).toBe("calm");
		expect(reading.overall).toBe("calm");
	});

	it("reads the payback distance as elevated approaching the threshold, and critical past it", () => {
		expect(
			readPressure({
				paybackMargin: 1.2,
				costPerTurnRatio: 1,
				reexpansionRate: 0,
			}).paybackDistance,
		).toBe("elevated");
		expect(
			readPressure({
				paybackMargin: 0.9,
				costPerTurnRatio: 1,
				reexpansionRate: 0,
			}).paybackDistance,
		).toBe("critical");
	});

	it("reads cost per turn against the session's own baseline the same way", () => {
		expect(
			readPressure({
				paybackMargin: 5,
				costPerTurnRatio: 1.6,
				reexpansionRate: 0,
			}).costPerTurn,
		).toBe("elevated");
		expect(
			readPressure({
				paybackMargin: 5,
				costPerTurnRatio: 2.5,
				reexpansionRate: 0,
			}).costPerTurn,
		).toBe("critical");
	});

	it("reads recent re-expansion rate the same way", () => {
		expect(
			readPressure({
				paybackMargin: 5,
				costPerTurnRatio: 1,
				reexpansionRate: 0.15,
			}).reexpansion,
		).toBe("elevated");
		expect(
			readPressure({
				paybackMargin: 5,
				costPerTurnRatio: 1,
				reexpansionRate: 0.35,
			}).reexpansion,
		).toBe("critical");
	});

	it("takes the worst of the three bands as the overall reading", () => {
		const reading = readPressure({
			paybackMargin: 5, // calm
			costPerTurnRatio: 1, // calm
			reexpansionRate: 0.35, // critical
		});
		expect(reading.overall).toBe("critical");
	});

	it("does not let two elevated inputs quietly become an overall critical", () => {
		// Pressure is the worst single band, not a sum: two things being
		// somewhat off is not the same claim as one thing being badly off,
		// and conflating them would make the reading harder to act on,
		// not easier.
		const reading = readPressure({
			paybackMargin: 1.2, // elevated
			costPerTurnRatio: 1.6, // elevated
			reexpansionRate: 0, // calm
		});
		expect(reading.overall).toBe("elevated");
	});
});
