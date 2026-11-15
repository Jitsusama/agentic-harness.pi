/**
 * Everything worth knowing about one element, gathered into one
 * inspection, and the space between two of them.
 *
 * Kept apart from the session because an inspection is a policy
 * over the node reads: which facts to ask for, in what order, and
 * how a refusal or an unreadable part is reported. That policy
 * changes when the inspection gains a fact, not when the protocol
 * reads underneath it do.
 */

import type { AxNode } from "../a11y/index.ts";
import { subtreeAt } from "../a11y/index.ts";
import {
	CONTENT_PROBE,
	judgeVisibility,
	measureBetween,
} from "../element/index.ts";
import { curateStyles } from "../styles/index.ts";
import {
	ambiguityRefusal,
	notFoundRefusal,
	resolveTarget,
	type Target,
} from "../target/index.ts";
import type { SessionNodes } from "./nodes.ts";
import type { SessionTargeting } from "./targeting.ts";
import type {
	Inspection,
	InspectOptions,
	InspectResult,
	MeasureResult,
	RenderedFont,
} from "./types.ts";
import type { SessionWires } from "./wires.ts";

/** One element inspected, through the session's node reads. */
export class SessionInspector {
	/** The live view of the browser the element is read through. */
	private readonly wires: SessionWires;

	/** The node reads an inspection is built from. */
	private readonly nodes: SessionNodes;

	/** How a target becomes a node. */
	private readonly targeting: SessionTargeting;

	constructor(
		wires: SessionWires,
		nodes: SessionNodes,
		targeting: SessionTargeting,
	) {
		this.wires = wires;
		this.nodes = nodes;
		this.targeting = targeting;
	}

	/**
	 * Everything worth knowing about one element.
	 *
	 * Each fact is asked of the browser rather than worked out
	 * here: the box from the layout engine, the occluder from a
	 * hit test, the styles from the cascade, the announcement from
	 * the accessibility tree.
	 */
	async inspect(
		target: Target,
		options: InspectOptions = {},
	): Promise<InspectResult> {
		const tree = await this.targeting.axTree();
		const resolution = resolveTarget(tree, target);
		if (resolution.kind === "notFound") {
			return { ok: false, refusal: notFoundRefusal(tree, target) };
		}
		if (resolution.kind === "ambiguous") {
			return { ok: false, refusal: ambiguityRefusal(tree, target) };
		}

		const node = subtreeAt(tree, resolution.backendDomId) ?? tree;
		const objectId = await this.nodes.objectFor(resolution.backendDomId);
		try {
			return {
				ok: true,
				inspection: await this.inspectNode(
					resolution.backendDomId,
					objectId,
					node,
					options,
				),
			};
		} finally {
			await this.nodes.release(objectId);
		}
	}

	/**
	 * Measure the space between two elements.
	 *
	 * The border box is the one measured, because that is the edge
	 * a designer sees and points at. Margins are the space itself,
	 * so measuring between margin boxes would report the gap that
	 * remains after the gap, which is nearly always zero.
	 */
	async measure(a: Target, b: Target): Promise<MeasureResult> {
		// Which target failed matters: the caller named two, and a
		// refusal that does not say which one leaves them guessing.
		const first = await this.inspect(a);
		if (!first.ok) return { ok: false, target: a, refusal: first.refusal };
		const second = await this.inspect(b);
		if (!second.ok) return { ok: false, target: b, refusal: second.refusal };

		const boxA = first.inspection.box;
		const boxB = second.inspection.box;
		if (boxA === undefined || boxB === undefined) {
			// An element with no box is not laid out, so there is no
			// space between it and anything. Saying which one it was
			// saves the caller inspecting both to find out.
			const missing = boxA === undefined ? a : b;
			return {
				ok: false,
				problem:
					`${missing.role} ${missing.name} has no box, so it is not ` +
					"laid out and there is no space between it and anything.",
			};
		}

		return { ok: true, measurement: measureBetween(boxA.border, boxB.border) };
	}

	/** Gather every fact about an element the browser will give. */
	private async inspectNode(
		backendNodeId: number,
		objectId: string | undefined,
		node: AxNode,
		options: InspectOptions,
	): Promise<Inspection> {
		const box = await this.nodes.boxOf(backendNodeId);
		const styles = objectId ? await this.nodes.stylesOf(objectId) : undefined;
		const viewport = await this.nodes.viewport();
		const coveredBy =
			box && objectId ? await this.nodes.occluderOf(objectId) : undefined;

		const visibility = judgeVisibility({
			rendered: box !== undefined,
			...(box === undefined ? {} : { border: box.border }),
			...(viewport === undefined ? {} : { viewport }),
			...(coveredBy === undefined ? {} : { coveredBy }),
			...(styles?.opacity === undefined
				? {}
				: { opacity: Number(styles.opacity) }),
			...(styles?.visibility === undefined
				? {}
				: { visibility: styles.visibility }),
		});

		const initials = await this.nodes.initials();
		const curated =
			styles === undefined
				? undefined
				: curateStyles(styles, {
						...(initials === undefined ? {} : { initials }),
						...(options.styles === undefined ? {} : { only: options.styles }),
					});

		const wantsBehaviour = options.behaviour === true && objectId !== undefined;
		const variants =
			options.states && objectId && curated
				? await this.nodes.variantsOf(
						backendNodeId,
						objectId,
						curated,
						options.states,
						initials,
						options,
					)
				: undefined;

		const content = objectId ? await this.contentOf(objectId) : undefined;
		const fonts = await this.fontsOf(backendNodeId);

		return {
			node,
			visibility,
			...(content ?? {}),
			...(fonts === undefined ? {} : { fonts }),
			...(box === undefined ? {} : { box }),
			...(curated === undefined ? {} : { styles: curated }),
			...(wantsBehaviour && objectId
				? {
						listeners: await this.nodes.listenersOf(objectId),
						delegated: await this.nodes.delegatedTo(objectId),
						animations: await this.nodes.animationsOf(objectId),
					}
				: {}),
			...(variants === undefined ? {} : { variants }),
			...(options.why === undefined
				? {}
				: {
						trace: await this.nodes.traceOf(backendNodeId, options.why, styles),
					}),
		};
	}

	/**
	 * Which fonts the browser actually painted with.
	 *
	 * A computed style reports the stack that was asked for, not
	 * what was used. "SF Pro, Helvetica, sans-serif" reads the same
	 * whether the first one loaded or the page quietly fell back to
	 * the third, which is most of the answer to why a screenshot
	 * from one machine does not match another.
	 */
	private async fontsOf(
		backendNodeId: number,
	): Promise<readonly RenderedFont[] | undefined> {
		const nodeId = await this.nodes.frontendNodeFor(backendNodeId);
		if (nodeId === undefined) return undefined;
		try {
			const { fonts } = await this.wires
				.cdp()
				.send("CSS.getPlatformFontsForNode", {
					nodeId,
				});
			if (fonts.length === 0) return undefined;
			return fonts.map((font) => ({
				family: font.familyName,
				glyphs: font.glyphCount,
			}));
		} catch {
			// An element with no text has no fonts, and a detached one
			// cannot be asked. Neither is worth failing an inspection.
			return undefined;
		}
	}

	/**
	 * The element's own words, and the attributes it carries.
	 *
	 * The accessible name answers what a control is called, which
	 * is a different question from what it says. A counter reading
	 * "42", a status reading "3 items updated" and an input holding
	 * a typed email all have names that say none of that, so
	 * asserting on them meant dropping to a raw evaluate. Data
	 * attributes are here for the same reason: teams hang test
	 * state on them, and the accessibility tree cannot see them.
	 */
	private async contentOf(objectId: string): Promise<
		| {
				text?: string;
				value?: string;
				attributes?: Readonly<Record<string, string>>;
		  }
		| undefined
	> {
		try {
			const { result } = await this.wires.cdp().send("Runtime.callFunctionOn", {
				objectId,
				returnByValue: true,
				functionDeclaration: CONTENT_PROBE,
			});
			const read = result.value as
				| { text: string; value?: string; attributes: [string, string][] }
				| undefined;
			if (read === undefined) return undefined;
			return {
				...(read.text === "" ? {} : { text: read.text }),
				...(read.value === undefined ? {} : { value: read.value }),
				...(read.attributes.length === 0
					? {}
					: { attributes: Object.fromEntries(read.attributes) }),
			};
		} catch {
			// A detached node cannot be read, and an inspection that
			// reports everything else is worth more than a refusal.
			return undefined;
		}
	}
}
