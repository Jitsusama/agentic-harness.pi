/**
 * Pressure: one reading over three independent signals, each already
 * built for its own reason before this composed them. The overall
 * reading is the worst single band, not a sum, because two things
 * being somewhat off is a different claim from one thing being badly
 * off, and averaging them away would make the reading harder to act
 * on rather than easier.
 */

export type PressureBand = "calm" | "elevated" | "critical";

export interface PressureInputs {
	/** How far a compaction sits from paying for itself. Below one, it already would. */
	readonly paybackMargin: number;
	/** This session's recent cost per turn, over its own frozen baseline. One is normal. */
	readonly costPerTurnRatio: number;
	/** Reexpanded over demoted, this session. */
	readonly reexpansionRate: number;
}

export interface PressureReading {
	readonly paybackDistance: PressureBand;
	readonly costPerTurn: PressureBand;
	readonly reexpansion: PressureBand;
	readonly overall: PressureBand;
}

const BAND_RANK: Record<PressureBand, number> = {
	calm: 0,
	elevated: 1,
	critical: 2,
};

function paybackBand(margin: number): PressureBand {
	if (margin < 1) return "critical";
	if (margin < 2) return "elevated";
	return "calm";
}

function costPerTurnBand(ratio: number): PressureBand {
	if (ratio > 2) return "critical";
	if (ratio > 1.5) return "elevated";
	return "calm";
}

function reexpansionBand(rate: number): PressureBand {
	if (rate > 0.25) return "critical";
	if (rate > 0.1) return "elevated";
	return "calm";
}

/** Read pressure across the three bands, and the worst of them as the overall reading. */
export function readPressure(inputs: PressureInputs): PressureReading {
	const paybackDistance = paybackBand(inputs.paybackMargin);
	const costPerTurn = costPerTurnBand(inputs.costPerTurnRatio);
	const reexpansion = reexpansionBand(inputs.reexpansionRate);
	const overall = [paybackDistance, costPerTurn, reexpansion].reduce(
		(worst, band) => (BAND_RANK[band] > BAND_RANK[worst] ? band : worst),
	);
	return { paybackDistance, costPerTurn, reexpansion, overall };
}
