/**
 * How readable a session's page is where a stylesheet can't say:
 * text over whatever lies behind it, and one element against
 * another.
 *
 * Kept apart from the session because judging contrast changes
 * for reasons of its own (the bar, how the background is read),
 * while resolving, capturing and releasing a node stay the
 * session's, handed in as hooks so there is one way of doing
 * each.
 */

import type { AxNode } from "../a11y/index.ts";
import {
	type BehindReport,
	type ContrastLevel,
	foldBehind,
	foldPair,
	type PaintedSide,
	type PairReport,
	parseRgb,
} from "../audit/index.ts";
import { HIDE_TEXT, OWN_TEXT_PROBE } from "../element/index.ts";
import type { ComputedStyles } from "../styles/index.ts";
import {
	ambiguityRefusal,
	notFoundRefusal,
	resolveTarget,
	type Target,
	type TargetRefusal,
} from "../target/index.ts";
import type { SessionWires } from "./wires.ts";

/** What judging contrast needs of the session's node handling. */
export interface ContrastHooks {
	/** The page's accessibility tree, once any recovery is over. */
	readonly axTree: () => Promise<AxNode>;
	/** A remote handle on the node, if it is still in the document. */
	readonly objectFor: (backendNodeId: number) => Promise<string | undefined>;
	/** The element that paints a node, which for text is its parent. */
	readonly paintingElement: (objectId: string) => Promise<string>;
	/** What the element computes to, if it can be read. */
	readonly stylesOf: (objectId: string) => Promise<ComputedStyles | undefined>;
	/** A shot of one node's region, its first tile's path first. */
	readonly capture: (
		backendNodeId: number,
	) => Promise<{ readonly paths: readonly string[] }>;
	/** Let go of a remote handle. */
	readonly release: (objectId: string | undefined) => Promise<void>;
	/** A shot's pixels, read off disk. */
	readonly readShot: (path: string) => Promise<BehindPixels>;
}

/** The pixels foldBehind reads from each shot. */
type BehindPixels = Parameters<typeof foldBehind>[0]["withText"];

/** Contrast read off a session's page, behind text or between two. */
export class SessionContrast {
	/** The live view of the browser the page is read through. */
	private readonly wires: SessionWires;

	/** The session's own way of resolving, capturing and releasing. */
	private readonly hooks: ContrastHooks;

	constructor(wires: SessionWires, hooks: ContrastHooks) {
		this.wires = wires;
		this.hooks = hooks;
	}

	/**
	 * Judge text against the background actually behind its glyphs.
	 *
	 * For the case axe hands back as needing a person: text over a
	 * gradient, a photograph, or anything else with no single
	 * background colour. Two shots of the same region, the second with
	 * the text hidden, give both the glyph mask and what lies under it.
	 *
	 * Hiding the text is a paint-only change, so nothing moves between
	 * the shots and the subtraction stays aligned. The inline style is
	 * put back in a finally, including the case where it had one of its
	 * own to begin with.
	 */
	async behind(
		target: Target,
		bar: ContrastLevel = "AA",
	): Promise<
		{ ok: true; report: BehindReport } | { ok: false; refusal: TargetRefusal }
	> {
		await this.wires.ready();
		const tree = await this.hooks.axTree();
		const resolution = resolveTarget(tree, target);
		if (resolution.kind === "notFound") {
			return { ok: false, refusal: notFoundRefusal(tree, target) };
		}
		if (resolution.kind === "ambiguous") {
			return { ok: false, refusal: ambiguityRefusal(tree, target) };
		}
		const backendNodeId = resolution.backendDomId;

		const named = await this.hooks.objectFor(backendNodeId);
		if (!named) {
			return { ok: false, refusal: notFoundRefusal(tree, target) };
		}
		// Naming a paragraph's text means naming its StaticText, since
		// a paragraph has no accessible name, and that resolves to a
		// text node. The colour and the hiding both belong to the
		// element painting it; the capture below still uses the named
		// node, whose box is the tighter one.
		const objectId = await this.hooks.paintingElement(named);

		try {
			const styles = await this.hooks.stylesOf(objectId);
			// No fallback here on purpose. parseRgb returns undefined for a
			// colour it cannot read, and the fold treats that as undecidable;
			// substituting black would answer confidently about a colour
			// nobody read.
			const colour = parseRgb(styles?.color ?? "");
			const sizing = {
				fontSizePx: Number.parseFloat(styles?.["font-size"] ?? "16") || 16,
				fontWeight: Number.parseFloat(styles?.["font-weight"] ?? "400") || 400,
			};

			const first = await this.hooks.capture(backendNodeId);
			await this.hideText(objectId, true);
			try {
				const second = await this.hooks.capture(backendNodeId);
				const withText = await this.hooks.readShot(first.paths[0] ?? "");
				const bare = await this.hooks.readShot(second.paths[0] ?? "");
				return {
					ok: true,
					report: foldBehind({
						withText,
						bare,
						textColour: colour
							? { r: colour.r, g: colour.g, b: colour.b }
							: undefined,
						sizing,
						bar,
					}),
				};
			} finally {
				await this.hideText(objectId, false);
			}
		} finally {
			await this.hooks.release(objectId);
			// Promoting a text node makes a second handle, and the node
			// that was named is still ours to let go of.
			if (named !== objectId) await this.hooks.release(named);
		}
	}

	/**
	 * Judge the contrast between two elements the caller named.
	 *
	 * Distinct from behind, which subtracts pixels to read the
	 * background under one element's glyphs. This compares two
	 * elements' stated colours, which is the only way to ask about a
	 * boundary: an icon against its card, a border against the page.
	 * Both sides are read from the computed style rather than the
	 * screen, so nothing is captured and nothing moves.
	 */
	async pair(
		one: Target,
		other: Target,
		bar: ContrastLevel = "AA",
	): Promise<
		| { ok: true; report: PairReport }
		// The failing target travels with the refusal, as it does for a
		// measurement between two elements. Without it the caller can
		// only render the refusal against the target it happens to hold,
		// which is the first one, and a caller told the subject was not
		// found goes and corrects a subject that was fine.
		| { ok: false; target: Target; refusal: TargetRefusal }
	> {
		await this.wires.ready();
		const tree = await this.hooks.axTree();
		const sides: PaintedSide[] = [];
		for (const target of [one, other]) {
			const resolution = resolveTarget(tree, target);
			if (resolution.kind === "notFound") {
				return { ok: false, target, refusal: notFoundRefusal(tree, target) };
			}
			if (resolution.kind === "ambiguous") {
				return { ok: false, target, refusal: ambiguityRefusal(tree, target) };
			}
			const named = await this.hooks.objectFor(resolution.backendDomId);
			if (!named) {
				return { ok: false, target, refusal: notFoundRefusal(tree, target) };
			}
			// Either side may be named as StaticText, which resolves to a
			// text node: no computed style to read, and no child text
			// nodes of its own, so it would also be judged as carrying no
			// text and drawn against the wrong criterion.
			const objectId = await this.hooks.paintingElement(named);
			try {
				sides.push(await this.paintedSide(objectId));
			} finally {
				await this.hooks.release(objectId);
				if (named !== objectId) await this.hooks.release(named);
			}
		}
		const [first, second] = sides;
		if (!first || !second) {
			// Only reachable if a side went missing after resolving, and
			// the loop above returns for anything it could name, so the
			// one still unaccounted for is the second.
			return {
				ok: false,
				target: other,
				refusal: notFoundRefusal(tree, other),
			};
		}
		return { ok: true, report: foldPair({ one: first, other: second, bar }) };
	}

	/** What one side of a contrast pairing paints. */
	private async paintedSide(objectId: string): Promise<PaintedSide> {
		const styles = await this.hooks.stylesOf(objectId);
		const { result } = await this.wires.cdp().send("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: OWN_TEXT_PROBE,
			returnByValue: true,
		});
		return {
			hasText: result.value === true,
			...(styles?.color === undefined ? {} : { color: styles.color }),
			...(styles?.["background-color"] === undefined
				? {}
				: { backgroundColor: styles["background-color"] }),
			...(styles?.["border-color"] === undefined
				? {}
				: { borderColor: styles["border-color"] }),
			sizing: {
				fontSizePx: Number.parseFloat(styles?.["font-size"] ?? "16") || 16,
				fontWeight: Number.parseFloat(styles?.["font-weight"] ?? "400") || 400,
			},
		};
	}

	/**
	 * Make an element's own text stop painting, and put it back.
	 *
	 * Only colour and shadow are touched, because neither affects
	 * layout: the glyphs still occupy the same pixels, they simply
	 * leave no mark on them.
	 */
	private async hideText(objectId: string, hidden: boolean): Promise<void> {
		try {
			await this.wires.cdp().send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: HIDE_TEXT,
				arguments: [{ value: hidden }],
				returnByValue: true,
			});
		} catch {
			// A page that navigated mid-measurement has already discarded
			// the element, so there is no style left to restore.
		}
	}
}
