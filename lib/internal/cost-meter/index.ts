/**
 * The cost meter: what the status line says about money and context.
 *
 * Shared between the extension that knows the figures and the widget
 * that lays them out, because those are different jobs. The brain must
 * not paint and the widget must not price.
 *
 * Nothing here emits colour. Each piece names a theme token and the
 * renderer applies it, which is what keeps the meter testable for what
 * it says rather than only for what it paints.
 */

export {
	type ContextGauge,
	contextGauge,
	GAP,
	type MeterToken,
	marginalText,
	medianOf,
	sessionText,
} from "./gauge.js";
