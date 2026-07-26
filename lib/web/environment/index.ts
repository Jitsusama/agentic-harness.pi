/**
 * The environment a page thinks it is running in: viewport,
 * media preferences, sight, locale and clock.
 *
 * The analysis here is capture-agnostic, so an observation
 * taken by another driver reads the same way.
 */

export {
	type Divergence,
	divergences,
	type EmulationState,
	type MediaFeature,
	mediaFeaturesOf,
	mergeEmulation,
	type ObservedEnvironment,
	type VisionDeficiency,
} from "./emulation.js";
export { ENVIRONMENT_PROBE } from "./probes.js";
export {
	type CookieRecord,
	renderStorage,
	type StorageSnapshot,
} from "./storage.js";
export { renderEnvironment } from "./view.js";
