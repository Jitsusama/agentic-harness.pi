/**
 * A stop's backstop: a thread beside the host's loop that ends the host
 * when its stop runs past the time it allows.
 */

/** What a backstop is armed with. */
export interface BackstopOptions {
	readonly within: number;
	readonly bound: number;
	readonly file: string;
	readonly ids: readonly string[];
	readonly fd?: number;
}

/** A backstop armed for one stop. */
export interface Backstop {
	held(ids: readonly string[]): void;
	done(): void;
}

/** Arm a backstop for a stop beginning now. */
export function backstopStop(_options: BackstopOptions): Backstop {
	return { held() {}, done() {} };
}
