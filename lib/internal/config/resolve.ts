/**
 * The config ladder's resolution rule: global, project, quest, call,
 * most specific wins, and the answer always says which layer it came
 * from rather than making the caller guess.
 *
 * This is the ladder's decision logic only. Where each layer's value
 * actually comes from is a separate concern: `global` reads from
 * `loader.ts`'s package config, which already exists; `project` and
 * `quest` need their own file conventions this does not define, and
 * `call` is whatever the call site passed in directly, no file at
 * all. Host filesystem layering is not this function's job, which is
 * exactly why it takes plain values rather than paths.
 */

export type ConfigLayer = "call" | "quest" | "project" | "global" | "default";

export interface LayeredValue<T> {
	readonly value: T;
	readonly layer: ConfigLayer;
}

/** Most specific first: a call-site override beats everything stored. */
const STORED_LAYER_ORDER: readonly Exclude<ConfigLayer, "default">[] = [
	"call",
	"quest",
	"project",
	"global",
];

/**
 * Resolve a value across the four layers, falling back to `fallback`
 * (reported as layer `"default"`) when none of them set it.
 *
 * A layer is "set" when its value is not `undefined`, so a real,
 * deliberate falsy value (zero, empty string, false) still counts,
 * and only an actually absent layer is skipped.
 */
export function resolveLayered<T>(
	layers: Partial<Record<Exclude<ConfigLayer, "default">, T | undefined>>,
	fallback: T,
): LayeredValue<T> {
	for (const layer of STORED_LAYER_ORDER) {
		const value = layers[layer];
		if (value !== undefined) return { value, layer };
	}
	return { value: fallback, layer: "default" };
}
