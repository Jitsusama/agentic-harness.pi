/**
 * Change detection against a frozen baseline, for metrics and for the
 * parameters that were meant to govern them.
 */

export { pressureTriggersAdvisor } from "./advisor-trigger.ts";
export {
	type CusumBaseline,
	type CusumOptions,
	type CusumPoint,
	computeBaseline,
	cusum,
} from "./cusum.ts";
export {
	type DeadHorseState,
	INITIAL_DEAD_HORSE,
	isDeadHorse,
	observeVerify,
} from "./dead-horse.ts";
export {
	type PressureBand,
	type PressureInputs,
	type PressureReading,
	readPressure,
} from "./pressure.ts";
export {
	choseWithPropensity,
	type PropensityChoice,
	type PropensityResult,
} from "./propensity.ts";
export {
	type CallOccurrence,
	type ClassifiedRepeat,
	classifyRepeats,
	type RepeatClass,
} from "./rework.ts";
