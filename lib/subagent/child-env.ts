/**
 * Variables a process pins for every subagent it starts, read afresh
 * at each start.
 *
 * A terminal pi's launcher exports the gateway key into pi's own
 * environment, so every child inherits it. A host holds no key there:
 * its engine resolves one per request and renews it as it expires. A
 * subagent is a pi of its own, whose providers read the key from the
 * environment it starts with, so the host pins what hands it the
 * current key here, and each runner lays it over what the child
 * inherits.
 *
 * Kept on `globalThis` under a `Symbol.for` key, as the startup install
 * is (install.ts), since each conversation loads this library afresh
 * and the host's engine pins it from outside any of them.
 */

import { isRecord } from "../internal/record.ts";

/** What a pinned source answers: the variables every child starts with. */
export type ChildEnvironment = () => Promise<Readonly<Record<string, string>>>;

const CHILD_ENV_KEY = Symbol.for("pi.subagent.childEnvironment");

/** Pin what every later subagent start takes its extra variables from. */
export function pinChildEnvironment(source: ChildEnvironment): void {
	Reflect.set(globalThis, CHILD_ENV_KEY, source);
}

/** The variables the pinned source gives now, or none when nothing is pinned. */
export async function pinnedChildEnvironment(): Promise<
	Readonly<Record<string, string>>
> {
	const source: unknown = Reflect.get(globalThis, CHILD_ENV_KEY);
	if (typeof source !== "function") return {};
	const given: unknown = await source();
	if (!isRecord(given)) return {};
	const values: Record<string, string> = {};
	for (const [name, value] of Object.entries(given))
		if (typeof value === "string") values[name] = value;
	return values;
}
