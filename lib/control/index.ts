/**
 * Change detection against a frozen baseline, for metrics and for the
 * parameters that were meant to govern them.
 */

export { pressureTriggersAdvisor } from "./advisor-trigger.js";
export {
	type CusumBaseline,
	type CusumOptions,
	type CusumPoint,
	computeBaseline,
	cusum,
} from "./cusum.js";
export {
	type DeadHorseState,
	INITIAL_DEAD_HORSE,
	isDeadHorse,
	observeVerify,
} from "./dead-horse.js";
export {
	type PressureBand,
	type PressureInputs,
	type PressureReading,
	readPressure,
} from "./pressure.js";
export {
	type CallOccurrence,
	type ClassifiedRepeat,
	classifyRepeats,
	type RepeatClass,
} from "./rework.js";
