/**
 * What a session's page paints beyond its layout: the layers the
 * compositor made, and what hovering or focusing an element
 * changes.
 *
 * Kept apart from the session because both are read through the
 * protocol's own domains (LayerTree, forced pseudo-states) and
 * change for reasons of their own. What they need of the
 * session's element handling comes in as hooks, so the session
 * keeps one way of resolving and reading a node.
 */

import {
	diffStyles,
	foldHover,
	HOVER_SCAN,
	type HoverMeasurement,
	type HoverReport,
	type HoverScan,
	MAX_HOVER_CANDIDATES,
	type PseudoState,
	type StyleChange,
} from "../element/index.ts";
import {
	foldLayers,
	LAYER_ROUNDS,
	LAYER_SETTLE_MS,
	type LayerReport,
	nameNode,
	namesAnElement,
	type RawLayer,
} from "../perf/index.ts";
import { type ComputedStyles, curateStyles } from "../styles/index.ts";
import type { SessionWires } from "./wires.ts";

/** What reading a hover needs of the session's element handling. */
export interface PaintingHooks {
	/** The front-end id a forced state is set on, if the node has one. */
	readonly frontendNodeFor: (
		backendNodeId: number,
	) => Promise<number | undefined>;
	/** A remote handle on the node, if it is still in the document. */
	readonly objectFor: (backendNodeId: number) => Promise<string | undefined>;
	/** What the element computes to, if it can be read. */
	readonly stylesOf: (objectId: string) => Promise<ComputedStyles | undefined>;
	/** Wait out the transition a forced state starts. */
	readonly settleForcedState: (objectId: string) => Promise<void>;
}

/** A session's layers and hover states, read off its page. */
export class SessionPainting {
	/** The live view of the browser the page is read through. */
	private readonly wires: SessionWires;

	/** The session's own way of resolving and reading a node. */
	private readonly hooks: PaintingHooks;

	constructor(wires: SessionWires, hooks: PaintingHooks) {
		this.wires = wires;
		this.hooks = hooks;
	}

	/**
	 * What the compositor is holding for this page, and why.
	 *
	 * LayerTree pushes nothing when it is enabled: the tree arrives
	 * only on layerTreeDidChange, and a page that has finished
	 * settling has no change left to report. Measured across seven
	 * candidates, a throwaway screenshot is the cheapest way to make
	 * Chrome recompose and hand the tree over, and the only one that
	 * alters nothing about the page. Scrolling moves the page,
	 * overriding device metrics disturbs an emulation the caller may
	 * have set, and toggling a style writes to the DOM.
	 *
	 * The domain goes off again afterwards, so a read leaves no
	 * instrumentation running behind it.
	 */
	async layers(): Promise<LayerReport> {
		await this.wires.ready();

		let latest: readonly RawLayer[] = [];
		const onChange = (payload: { layers?: RawLayer[] }): void => {
			if (payload.layers) latest = payload.layers;
		};
		this.wires.cdp().on("LayerTree.layerTreeDidChange", onChange);
		try {
			await this.wires.cdp().send("LayerTree.enable");
			// Each screenshot makes Chrome compose a frame, and so send a tree.
			for (let round = 0; round < LAYER_ROUNDS; round++) {
				await this.wires
					.cdp()
					.send("Page.captureScreenshot", { format: "png" });
				await this.settleLayers();
				if (namesAnElement(latest)) break;
			}
		} finally {
			this.wires.cdp().off("LayerTree.layerTreeDidChange", onChange);
			// Best effort: a disable that fails leaves the domain on, which
			// costs a little work per frame but breaks nothing, and is not
			// worth failing the read over.
			await this.wires
				.cdp()
				.send("LayerTree.disable")
				.catch(() => undefined);
		}

		// Snapshotted before anything is asked about it. Every await
		// below lets another change land, and a loop reading the live
		// array attributes one layer's reasons to another's id.
		const layers = [...latest];
		const reasons: Record<string, readonly string[]> = {};
		const elements: Record<string, string> = {};
		for (const layer of layers) {
			reasons[layer.layerId] = await this.reasonsFor(layer.layerId);
			const named = await this.nameOfNode(layer.backendNodeId);
			if (named !== undefined) elements[layer.layerId] = named;
		}

		return foldLayers({ layers, reasons, elements });
	}

	/**
	 * What the page does on hover, and whether focus does it too.
	 *
	 * Two halves, because either alone lies. The stylesheets say
	 * which elements might hover, cheaply and in one round trip, but
	 * a declared rule the cascade beat changes nothing a person can
	 * see. So the scan only proposes candidates, and each one is then
	 * held in hover and in focus and read, which is the only account
	 * of what actually happens.
	 *
	 * Bounded because there is a round trip per candidate, measured
	 * at roughly 9ms for the pair of states.
	 */
	async hovers(limit = MAX_HOVER_CANDIDATES): Promise<HoverReport> {
		await this.wires.ready();

		const scan = await this.scanForHover();
		const measurements: HoverMeasurement[] = [];
		const seen = new Set<number>();

		for (const selector of scan.selectors) {
			if (measurements.length >= limit) break;
			for (const found of await this.nodesMatching(selector)) {
				if (measurements.length >= limit) break;
				// One element can match two hover selectors. Measuring it
				// twice would report one treatment as two.
				if (seen.has(found)) continue;
				seen.add(found);
				const measured = await this.measureHover(found);
				if (measured) measurements.push(measured);
			}
		}

		return foldHover(measurements, scan.unreadableSheets);
	}

	/** Which selectors carry a hover, as the page's own sheets say. */
	private async scanForHover(): Promise<HoverScan> {
		try {
			const { result } = await this.wires.cdp().send("Runtime.evaluate", {
				expression: HOVER_SCAN,
				returnByValue: true,
			});
			const parsed: unknown = JSON.parse(String(result.value));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"selectors" in parsed &&
				Array.isArray(parsed.selectors)
			) {
				const sheets =
					"unreadableSheets" in parsed &&
					typeof parsed.unreadableSheets === "number"
						? parsed.unreadableSheets
						: 0;
				return {
					selectors: parsed.selectors.filter(
						(one): one is string => typeof one === "string",
					),
					unreadableSheets: sheets,
				};
			}
			return { selectors: [], unreadableSheets: 0 };
		} catch {
			// A page that navigated mid-scan has no stylesheets to report.
			return { selectors: [], unreadableSheets: 0 };
		}
	}

	/** Backend ids matching a selector, or none if it will not parse. */
	private async nodesMatching(selector: string): Promise<readonly number[]> {
		try {
			const { root } = await this.wires
				.cdp()
				.send("DOM.getDocument", { depth: 0 });
			const { nodeIds } = await this.wires
				.cdp()
				.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
			const backend: number[] = [];
			for (const nodeId of nodeIds) {
				const { node } = await this.wires
					.cdp()
					.send("DOM.describeNode", { nodeId });
				if (node.backendNodeId !== undefined) backend.push(node.backendNodeId);
			}
			return backend;
		} catch {
			// A selector Chrome will not parse, which a stylesheet can
			// legally contain once its hover part is stripped off.
			return [];
		}
	}

	/** Hold hover, then focus, and read what each changed. */
	private async measureHover(
		backendNodeId: number,
	): Promise<HoverMeasurement | undefined> {
		const nodeId = await this.hooks.frontendNodeFor(backendNodeId);
		if (nodeId === undefined) return undefined;
		const objectId = await this.hooks.objectFor(backendNodeId);
		if (objectId === undefined) return undefined;

		const named = await this.nameOfNode(backendNodeId);
		const atRest = await this.hooks.stylesOf(objectId);
		if (!atRest) return undefined;
		const resting = curateStyles(atRest, {});

		const read = async (
			state: PseudoState,
		): Promise<readonly StyleChange[]> => {
			await this.wires.cdp().send("CSS.forcePseudoState", {
				nodeId,
				forcedPseudoClasses: [state],
			});
			await this.hooks.settleForcedState(objectId);
			const held = await this.hooks.stylesOf(objectId);
			return held ? diffStyles(resting, curateStyles(held, {})) : [];
		};

		try {
			const hover = await read("hover");
			const focus = await read("focus");
			return { element: named ?? `node ${backendNodeId}`, hover, focus };
		} finally {
			// Always released. A page left stuck in a forced hover would
			// corrupt every later reading of it, and a restoration written
			// after the reads would not run when one of them throws.
			await this.wires
				.cdp()
				.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] })
				.catch(() => undefined);
		}
	}

	/** Why Chrome composited one layer, or nothing if it will not say. */
	private async reasonsFor(layerId: string): Promise<readonly string[]> {
		try {
			const answer = await this.wires
				.cdp()
				.send("LayerTree.compositingReasons", { layerId });
			return answer.compositingReasons ?? [];
		} catch {
			// The layer went away between the snapshot and the question,
			// which is silence about it rather than a reason to fail.
			return [];
		}
	}

	/** A short name for the element behind a layer. */
	private async nameOfNode(
		backendNodeId: number | undefined,
	): Promise<string | undefined> {
		if (backendNodeId === undefined) return undefined;
		try {
			const { node } = await this.wires
				.cdp()
				.send("DOM.describeNode", { backendNodeId });
			return nameNode(node.nodeName, node.attributes);
		} catch {
			// A node that has left the document cannot be named, and a
			// layer without a name is still worth reporting by id.
			return undefined;
		}
	}

	/** Give the compositor a moment to finish reporting. */
	private settleLayers(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, LAYER_SETTLE_MS));
	}
}
