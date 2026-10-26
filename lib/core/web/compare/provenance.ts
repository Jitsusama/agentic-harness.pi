/**
 * What a visual baseline was recorded under, and whether a later
 * capture is comparable to it.
 *
 * A baseline is a claim about one page under one set of
 * conditions. Without recording those conditions a comparison
 * cannot tell a regression from a change of subject: record on
 * the cart page, navigate to the checkout page, compare, and the
 * diff reports confident failures attributed to the checkout
 * page's elements. Image size alone cannot catch it, because two
 * pages at the same viewport are the same size.
 *
 * Pure: the session captures the facts, this decides what they
 * mean, and a capture from anywhere else works the same way.
 */

/** The conditions a baseline image was taken under. */
export interface BaselineProvenance {
	/** The page the shot was of. */
	readonly url: string;
	/** Emulated viewport width, when one was set. */
	readonly width?: number;
	/** Emulated viewport height, when one was set. */
	readonly height?: number;
	/** Device pixel ratio the shot was rasterized at. */
	readonly deviceScaleFactor: number;
}

/** Where the provenance for a baseline image lives. */
export function sidecarFor(baselinePath: string): string {
	return `${baselinePath}.json`;
}

/** Serialize provenance for storage beside its image. */
export function stringify(provenance: BaselineProvenance): string {
	return `${JSON.stringify(provenance, null, "\t")}\n`;
}

/**
 * Read provenance back, or undefined when there is none to read.
 *
 * Undefined is a real answer rather than a failure: baselines
 * recorded before provenance existed have no sidecar, and
 * discarding them would turn an upgrade into silent data loss.
 */
export function parse(text: string): BaselineProvenance | undefined {
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null) return undefined;
		const record = raw as Record<string, unknown>;
		if (typeof record.url !== "string") return undefined;
		if (typeof record.deviceScaleFactor !== "number") return undefined;
		return {
			url: record.url,
			...(typeof record.width === "number" ? { width: record.width } : {}),
			...(typeof record.height === "number" ? { height: record.height } : {}),
			deviceScaleFactor: record.deviceScaleFactor,
		};
	} catch {
		// A truncated or hand-edited sidecar is not worth failing a
		// comparison over. Treating it as absent falls back to the
		// behaviour baselines had before provenance was recorded.
		return undefined;
	}
}

/** A viewport as it reads in a refusal. */
function viewportOf(provenance: BaselineProvenance): string {
	const { width, height } = provenance;
	if (width === undefined && height === undefined) return "no set viewport";
	return `${width ?? "auto"}x${height ?? "auto"}`;
}

/**
 * Say how a capture differs from the baseline's conditions, or
 * undefined when the two are comparable.
 *
 * The message names both sides, because the useful next step
 * differs completely depending on which one is wrong: a changed
 * URL means the wrong baseline was named, and a changed viewport
 * means the emulation drifted.
 */
export function describeDrift(
	was: BaselineProvenance,
	now: BaselineProvenance,
): string | undefined {
	if (was.url !== now.url) {
		return (
			`the baseline was recorded on ${was.url} and this is ` +
			`${now.url}. Comparing two different pages would report ` +
			"every difference between them as a regression."
		);
	}
	if (was.width !== now.width || was.height !== now.height) {
		return (
			`the baseline was recorded at ${viewportOf(was)} and this is ` +
			`${viewportOf(now)}. Re-record it, or set the viewport back.`
		);
	}
	if (was.deviceScaleFactor !== now.deviceScaleFactor) {
		return (
			`the baseline was rasterized at ${was.deviceScaleFactor}x and ` +
			`this is ${now.deviceScaleFactor}x. Every edge would differ.`
		);
	}
	return undefined;
}
