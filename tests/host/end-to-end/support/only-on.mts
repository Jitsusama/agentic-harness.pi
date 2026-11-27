// A host case that only one platform can run, skipped elsewhere saying which platform, in its note and its meta.
/**
 * Some host cases read what only one platform has, as Linux's /proc. On
 * another they can't run, which is no check left unmade, so `pnpm
 * test:host`'s reporter (every-case-ran.mts) and the proof's judge
 * (host/service/proof.ts) let such a skip by, rather than failing the
 * Mac's whole run for it. Both know one from the platform its meta
 * names, which only these helpers write, so every other skip still fails.
 */
import { it, type TestFunction } from "vitest";
import { ONLY_ON_KEY } from "../../../../host/service/proof.ts";

declare module "vitest" {
	interface TaskMeta {
		/** The one platform this case runs on, once it skipped on another. */
		onlyOn?: NodeJS.Platform;
	}
}

/** What a platform's own case says as it skips elsewhere. */
export function onlyOnNote(platform: NodeJS.Platform, why: string): string {
	return `only on ${platform}: ${why}`;
}

/**
 * The body a case only `platform` runs registers on `here`: `fn` itself
 * there, and elsewhere a skip naming `platform` in its meta and, with
 * `why`, in its note.
 */
export function onlyOnBody(
	platform: NodeJS.Platform,
	why: string,
	fn: TestFunction,
	here: string = process.platform,
): TestFunction {
	if (here === platform) return fn;
	return ({ skip, task }) => {
		task.meta[ONLY_ON_KEY] = platform;
		skip(onlyOnNote(platform, why));
	};
}

/**
 * `it`, on `platform`; on any other, a case of the same name that skips
 * saying it runs only on `platform`, and `why`.
 */
export function itOnlyOn(platform: NodeJS.Platform, why: string) {
	return (name: string, fn: TestFunction, timeout?: number): void => {
		it(name, onlyOnBody(platform, why, fn), timeout);
	};
}
