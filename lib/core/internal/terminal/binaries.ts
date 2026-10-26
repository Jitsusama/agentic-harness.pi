/**
 * Where each terminal's binary is, for the whole process.
 *
 * A person may say where a terminal lives, in the `terminal.drivers`
 * settings, and otherwise it is found on PATH. Either way every driver
 * runs the same absolute path discovery found, so a terminal is never
 * offered from one place and run from another. The answers are cached
 * for as long as PATH and the configured paths stay the same.
 */

import {
	type ExecutableCheck,
	isExecutableFile,
	resolveBinary,
} from "./binary.ts";

let overrides: ReadonlyMap<string, string> = new Map();
let cache = new Map<string, string | undefined>();
let cachedFor = "";

/**
 * Say where terminals live, by driver or launcher id, replacing any
 * earlier word. An id left out is looked up on PATH.
 */
export function setBinaryOverrides(
	paths: Readonly<Record<string, string>>,
): void {
	overrides = new Map(Object.entries(paths));
	cache = new Map();
}

/** The configured path for an id, if the person gave one. */
export function binaryOverride(id: string): string | undefined {
	return overrides.get(id);
}

/**
 * The absolute path a terminal's binary resolves to, or undefined when
 * it cannot be found. `id` is the driver or launcher asking, so a
 * configured path for it wins over `name` on PATH.
 */
export function locateBinary(
	id: string,
	name: string,
	path: string | undefined = process.env.PATH,
	isExecutable: ExecutableCheck = isExecutableFile,
): string | undefined {
	const key = `${path ?? ""}`;
	if (key !== cachedFor) {
		cache = new Map();
		cachedFor = key;
	}
	const wanted = overrides.get(id) ?? name;
	const cacheKey = `${id}\u0000${wanted}`;
	if (cache.has(cacheKey)) return cache.get(cacheKey);
	const found = resolveBinary(wanted, path, isExecutable);
	cache.set(cacheKey, found);
	return found;
}

/** Forget every cached answer, as after a call through one failed. */
export function forgetBinaries(): void {
	cache = new Map();
}
