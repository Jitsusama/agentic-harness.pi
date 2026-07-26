/**
 * Bending the network under the page.
 *
 * Two different needs share this module. Mocking and blocking
 * answer "what does this page do when that request returns
 * something else, or nothing at all", which is the only honest
 * way to see an error path that a healthy server never
 * produces. Throttling answers "what is this like on a train".
 */

/** What to do with a request that matches. */
export type ShapeAction = "mock" | "block";

/** One instruction about a family of requests. */
export interface NetworkRule {
	readonly pattern: string;
	readonly action: ShapeAction;
	/** For a mock: the status to answer with. Defaults to 200. */
	readonly status?: number;
	/** For a mock: the body to answer with. */
	readonly body?: string;
	/** For a mock: what the body is. */
	readonly contentType?: string;
	/** For a block: the reason Chrome should report. */
	readonly reason?: string;
}

/** How fast the network should pretend to be. */
export interface ThrottleConditions {
	readonly offline: boolean;
	/** Bytes per second down, 0 meaning no limit. */
	readonly download: number;
	/** Bytes per second up, 0 meaning no limit. */
	readonly upload: number;
	/** Round trip milliseconds added to every request. */
	readonly latency: number;
}

/**
 * The profiles Chrome's own devtools ships.
 *
 * Written as the expressions from its source rather than as
 * the products, so the derivation stays checkable: a datasheet
 * bandwidth, a loss factor, and a round trip multiplied to
 * account for the several trips a real request makes. Chrome
 * renamed "Fast 3G" to "Slow 4G" in 2024, and both names are
 * accepted so neither vocabulary is wrong here.
 */
export const THROTTLE_PROFILES: Readonly<Record<string, ThrottleConditions>> = {
	offline: { offline: true, download: 0, upload: 0, latency: 0 },
	"slow-3g": {
		offline: false,
		download: ((500 * 1000) / 8) * 0.8,
		upload: ((500 * 1000) / 8) * 0.8,
		latency: 400 * 5,
	},
	"slow-4g": {
		offline: false,
		download: ((1.6 * 1000 * 1000) / 8) * 0.9,
		upload: ((750 * 1000) / 8) * 0.9,
		latency: 150 * 3.75,
	},
	"fast-4g": {
		offline: false,
		download: ((9 * 1000 * 1000) / 8) * 0.9,
		upload: ((1.5 * 1000 * 1000) / 8) * 0.9,
		latency: 60 * 2.75,
	},
	none: { offline: false, download: 0, upload: 0, latency: 0 },
};

/** The name Chrome used before 2024, kept so it still works. */
const PROFILE_ALIASES: Readonly<Record<string, string>> = {
	"fast-3g": "slow-4g",
	"3g": "slow-3g",
	"4g": "fast-4g",
};

/** A named profile, under either the current or the old name. */
export function throttleProfile(name: string): ThrottleConditions | undefined {
	const key = name.toLowerCase();
	return THROTTLE_PROFILES[PROFILE_ALIASES[key] ?? key];
}

/** Every profile name that can be asked for. */
export function throttleNames(): readonly string[] {
	return Object.keys(THROTTLE_PROFILES);
}

/**
 * Whether a url answers to a pattern.
 *
 * Patterns are globs because that is what the protocol's own
 * request interception uses, so one vocabulary covers both what
 * we match locally and what we ask Chrome to intercept.
 */
export function matchesPattern(pattern: string, url: string): boolean {
	if (pattern === "*") return true;
	const expression = pattern
		// Escape everything a regular expression would read, then
		// give the star back its meaning.
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${expression}$`).test(url) || url.includes(pattern);
}

/**
 * The rule that governs a url, or none.
 *
 * First match wins, in the order the rules were given, so a
 * caller can put a specific exception ahead of a general rule
 * and have it hold.
 */
export function ruleFor(
	rules: readonly NetworkRule[],
	url: string,
): NetworkRule | undefined {
	return rules.find((rule) => matchesPattern(rule.pattern, url));
}

/** What the network is currently being made to do. */
export function renderShaping(
	rules: readonly NetworkRule[],
	throttle: ThrottleConditions | undefined,
): string {
	const lines: string[] = [];

	if (throttle?.offline) {
		lines.push("The network is offline.");
	} else if (throttle && (throttle.latency > 0 || throttle.download > 0)) {
		lines.push(
			`Throttled to ${Math.round(throttle.download / 1024)} KB/s down, ` +
				`${Math.round(throttle.upload / 1024)} KB/s up, ` +
				`${Math.round(throttle.latency)}ms latency.`,
		);
	} else {
		lines.push("The network is unshaped.");
	}

	if (rules.length === 0) {
		lines.push("No requests are being mocked or blocked.");
	} else {
		lines.push("", "Rules, first match winning:");
		for (const rule of rules) {
			lines.push(
				rule.action === "block"
					? `  block  ${rule.pattern}`
					: `  mock   ${rule.pattern} -> ${rule.status ?? 200}` +
							`${rule.contentType ? ` ${rule.contentType}` : ""}`,
			);
		}
	}

	return lines.join("\n");
}
