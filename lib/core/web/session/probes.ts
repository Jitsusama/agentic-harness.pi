/**
 * What the page says of itself when asked in one pass: its
 * flattened snapshot, an expression's value, the accessibility
 * audit, motion under reduce, structure, pointer targets,
 * hydration, typography, layout, styles in use and web vitals.
 *
 * Kept apart from the session because each of these is one probe
 * sent and one answer folded, and they change when an audit needs
 * a new fact rather than when the page is driven differently.
 * Judging what comes back is each analysis domain's job; this only
 * fetches it.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RawAxNode } from "../a11y/index.ts";
import {
	type A11yFinding,
	type AxFacts,
	buildStructure,
	type CapturedTarget,
	type ConformanceBar,
	enabledRules,
	MOTION_CAPTURE,
	type MotionCapture,
	type PageBox,
	type RawAxeRun,
	readAxeRun,
	type StructureNode,
	TARGET_CAPTURE,
	type VisualNode,
	visualCaptureSource,
} from "../audit/index.ts";
import {
	inventorySource,
	type StyleSample,
	type TextBlock,
	TYPOGRAPHY_CAPTURE,
} from "../design/index.ts";
import {
	describeThrow,
	type EvalOutcome,
	type EvalValue,
	evaluationSource,
} from "../evaluate/index.ts";
import {
	HYDRATION_CAPTURE,
	type HydrationCapture,
} from "../hydration/index.ts";
import {
	observerBootstrap,
	readVitalsSource,
	type Vitals,
} from "../perf/index.ts";
import {
	flattenSnapshot,
	type IndexedNode,
	type RawSnapshot,
} from "../snapshot/index.ts";
import type { EmulationController } from "./emulation.ts";
import type { SourceMapStore } from "./sourcemaps.ts";
import type { SessionWires } from "./wires.ts";

/**
 * The styles a snapshot carries by default.
 *
 * Enough to answer why something is not where it should be,
 * without dragging the whole computed style of every node into
 * the answer.
 */
const SNAPSHOT_STYLES: readonly string[] = [
	"display",
	"visibility",
	"opacity",
	"position",
	"color",
	"background-color",
	"font-size",
];

/**
 * Where axe-core's bundle sits on disk.
 *
 * Resolved through node rather than assembled from a relative
 * path, so it keeps working wherever the package is installed
 * and however the dependency is hoisted.
 */
function axeSource(): string {
	return createRequire(import.meta.url).resolve("axe-core/axe.min.js");
}

/** What probing needs of the session beyond its wires. */
export interface ProbeHooks {
	/** Fetch the page again, so motion is decided under the preference. */
	readonly reload: () => Promise<unknown>;
}

/** One-pass readings of the page, through the session's channel. */
export class SessionProbes {
	/** The live view of the browser the probes are sent through. */
	private readonly wires: SessionWires;

	/** What the session pretends, which the motion probe changes. */
	private readonly emulation: EmulationController;

	/** The maps that tell a thrown frame where it was written. */
	private readonly sourceMaps: SourceMapStore;

	/** What the session lends beyond its wires. */
	private readonly hooks: ProbeHooks;

	constructor(
		wires: SessionWires,
		emulation: EmulationController,
		sourceMaps: SourceMapStore,
		hooks: ProbeHooks,
	) {
		this.wires = wires;
		this.emulation = emulation;
		this.sourceMaps = sourceMaps;
		this.hooks = hooks;
	}

	/**
	 * The whole page flattened, frames and shadow content
	 * included.
	 *
	 * The style properties have to be named up front because the
	 * protocol returns their values as a bare array positioned
	 * against the request. Asking for a handful keeps the snapshot
	 * small; asking for none still gives geometry and structure.
	 */
	async snapshot(
		styleProperties: readonly string[] = SNAPSHOT_STYLES,
	): Promise<readonly IndexedNode[]> {
		await this.wires.ready();
		const raw = await this.wires.cdp().send("DOMSnapshot.captureSnapshot", {
			computedStyles: [...styleProperties],
			includeDOMRects: true,
		});
		return flattenSnapshot(raw as unknown as RawSnapshot, styleProperties);
	}

	/**
	 * Run an expression in the page and describe what came back.
	 *
	 * The value is serialized inside the page rather than by the
	 * protocol, because the protocol does not decline politely: a
	 * circular object rejects the whole call with "object
	 * reference chain is too long", losing the evaluation and any
	 * account of it together.
	 *
	 * The protocol can still fail for its own reasons, so that is
	 * caught too and returned as a refusal rather than thrown. An
	 * expression that kills the session is not a useful tool.
	 */
	async evaluate(expression: string): Promise<EvalOutcome> {
		await this.wires.ready();
		try {
			const response = await this.wires.cdp().send("Runtime.evaluate", {
				expression: evaluationSource(expression),
				returnByValue: true,
				awaitPromise: true,
				userGesture: true,
			});
			if (response.exceptionDetails) {
				const threw = describeThrow(response.exceptionDetails);
				return {
					ok: false,
					threw: {
						...threw,
						frames: await this.sourceMaps.resolveFrames(threw.frames),
					},
				};
			}
			const value = response.result.value as EvalValue | undefined;
			if (!value) {
				return {
					ok: false,
					refused: "The page returned nothing the serializer could read.",
				};
			}
			return { ok: true, result: value };
		} catch (error) {
			return {
				ok: false,
				refused:
					"The browser refused to run that: " +
					`${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * Run axe-core against the page and read back its findings.
	 *
	 * axe is injected fresh on every call rather than kept across
	 * navigations. It is half a megabyte, but a navigation clears
	 * the world, and an audit that silently reported nothing
	 * because the library went away with the last page would be
	 * worse than a slow one.
	 *
	 * Only violations and incomplete results are asked for. Passes
	 * and inapplicable rules together outweigh them by an order of
	 * magnitude and answer a question nobody asks.
	 *
	 * The experimental rules are switched on. axe leaves them off,
	 * and five of them carry real WCAG criteria, so leaving them
	 * off means 2.5.3 (label in name) is never checked and 1.3.1
	 * is checked less thoroughly than it looks. An accessibility
	 * reviewer reported label in name as missing, and it was, in
	 * the sense that matters: the rule sat in the bundle unused.
	 * Their findings are reported as needing a person rather than
	 * as failures, since axe's own doubt travels with them.
	 */
	async audit(bar: ConformanceBar = "AAA"): Promise<readonly A11yFinding[]> {
		await this.wires.ready();
		const source = await readFile(axeSource(), "utf8");
		await this.wires.cdp().send("Runtime.evaluate", { expression: source });
		const response = await this.wires.cdp().send("Runtime.evaluate", {
			expression:
				"axe.run(document, { " +
				'resultTypes: ["violations", "incomplete"], ' +
				`rules: ${JSON.stringify(enabledRules(bar))} })`,
			awaitPromise: true,
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`axe could not run: ${threw.message}`);
		}
		return readAxeRun((response.result.value ?? {}) as RawAxeRun);
	}

	/**
	 * What the page keeps doing when asked to hold still.
	 *
	 * Emulates prefers-reduced-motion: reduce, reloads so the page
	 * decides its motion under the preference rather than being
	 * caught mid-flight, reads what is still moving, then puts the
	 * emulation back exactly as it was. The reload matters: a page
	 * picks most of its motion at load, so flipping the preference
	 * on a settled page measures its reaction to a change, not its
	 * behaviour for a visitor who arrived with the preference set.
	 */
	async motionUnderReduce(): Promise<MotionCapture> {
		await this.wires.ready();
		const before = this.emulation.asked;
		try {
			await this.emulation.change({ reducedMotion: true });
			await this.hooks.reload();
			const response = await this.wires.cdp().send("Runtime.evaluate", {
				expression: MOTION_CAPTURE,
				returnByValue: true,
			});
			if (response.exceptionDetails) {
				const threw = describeThrow(response.exceptionDetails);
				throw new Error(`Could not read the motion: ${threw.message}`);
			}
			return response.result.value as MotionCapture;
		} finally {
			// Wholesale, not merged: a merge cannot clear the reduce
			// this added when the session had no opinion before.
			await this.emulation.restore(before);
		}
	}

	/**
	 * The page as the structural rules need to see it.
	 *
	 * Two accounts from the browser, joined on the backend node id
	 * they share: the snapshot for attributes and layout, the
	 * accessibility tree for roles and names. Neither carries
	 * both, and every structural rule needs both.
	 */
	async structure(): Promise<readonly StructureNode[]> {
		// Every sibling read waits out a crash recovery first, and
		// this one did not. Promise.all evaluates this.wires.cdp().send when
		// the array is built, so a call landing during recovery sent
		// getFullAXTree down the channel recover() was replacing.
		await this.wires.ready();
		const [nodes, tree] = await Promise.all([
			this.snapshot(),
			this.wires.cdp().send("Accessibility.getFullAXTree") as Promise<{
				nodes: RawAxNode[];
			}>,
		]);
		const facts: AxFacts[] = [];
		for (const axNode of tree.nodes) {
			if (axNode.backendDOMNodeId === undefined) continue;
			const focusable = axNode.properties?.find(
				(property) => property.name === "focusable",
			);
			facts.push({
				backendNodeId: axNode.backendDOMNodeId,
				...(axNode.role?.value === undefined
					? {}
					: { role: axNode.role.value }),
				...(axNode.name?.value === undefined
					? {}
					: { name: axNode.name.value }),
				// Left absent when the tree did not say, rather than
				// flattened to false. An ignored node carries no
				// properties at all, and reporting that as "cannot take
				// focus" is how the hidden-but-focusable rule ended up
				// unable to see its own subject.
				...(focusable === undefined
					? {}
					: { focusable: focusable.value?.value === true }),
			});
		}
		return buildStructure(nodes, facts);
	}

	/**
	 * Every pointer target on the page, with the facts WCAG 2.5.8
	 * needs to judge its size.
	 *
	 * Separate from layout() because the two ask different
	 * questions: layout wants everything drawn, this wants only
	 * what a finger has to hit, plus the two exceptions the
	 * criterion turns on.
	 */
	async targets(): Promise<readonly CapturedTarget[]> {
		await this.wires.ready();
		const response = await this.wires.cdp().send("Runtime.evaluate", {
			expression: TARGET_CAPTURE,
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not measure the targets: ${threw.message}`);
		}
		return response.result.value as readonly CapturedTarget[];
	}

	/**
	 * Both renders of the current page: what the server sends and
	 * what hydration made of it.
	 *
	 * The server render is fetched from inside the page, so it
	 * travels with the session's cookies, and parsed without
	 * running a script. Judging the capture is the hydration
	 * subdomain's job; pair it with logs() so the framework's own
	 * complaints are read beside the comparison.
	 */
	async hydration(): Promise<HydrationCapture> {
		await this.wires.ready();
		const response = await this.wires.cdp().send("Runtime.evaluate", {
			expression: HYDRATION_CAPTURE,
			awaitPromise: true,
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not read the renders: ${threw.message}`);
		}
		return response.result.value as HydrationCapture;
	}

	/**
	 * How the page's text blocks wrap, measured from real line
	 * boxes rather than estimated from fonts.
	 */
	async typography(): Promise<readonly TextBlock[]> {
		await this.wires.ready();
		const response = await this.wires.cdp().send("Runtime.evaluate", {
			expression: TYPOGRAPHY_CAPTURE,
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not measure the text: ${threw.message}`);
		}
		return response.result.value as readonly TextBlock[];
	}

	/**
	 * What the layout actually did, as the browser measured it.
	 *
	 * Read in one page-side pass rather than a protocol call per
	 * element: a page of any size would otherwise cost thousands
	 * of round trips to answer one question.
	 */
	async layout(): Promise<{
		readonly nodes: readonly VisualNode[];
		readonly viewport: PageBox;
	}> {
		await this.wires.ready();
		const response = await this.wires.cdp().send("Runtime.evaluate", {
			expression: visualCaptureSource(),
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not read the layout: ${threw.message}`);
		}
		return response.result.value as {
			nodes: readonly VisualNode[];
			viewport: PageBox;
		};
	}

	/**
	 * What the page is built from, sampled element by element.
	 *
	 * Read in one page-side pass, and filtered there rather than
	 * here: an inherited value is not a decision, and carrying
	 * every element's inherited colour back only to discard it
	 * would be most of the payload.
	 */
	async styleSamples(): Promise<readonly StyleSample[]> {
		await this.wires.ready();
		const response = await this.wires.cdp().send("Runtime.evaluate", {
			expression: inventorySource(),
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not sample the styles: ${threw.message}`);
		}
		return (response.result.value ?? []) as readonly StyleSample[];
	}

	/**
	 * Install the performance observers ahead of every page.
	 *
	 * Largest contentful paint and layout shift are events rather
	 * than state, so an observer registered after a page loads has
	 * missed them. The buffered flag recovers the timings but not
	 * the element that painted or the nodes that moved, which is
	 * the half worth having, so this goes in through the hook that
	 * runs before the document does.
	 */
	async watchVitals(): Promise<void> {
		await this.wires.cdp().send("Page.addScriptToEvaluateOnNewDocument", {
			source: observerBootstrap(),
		});
	}

	/** What the current page cost to show. */
	async vitals(): Promise<Vitals> {
		await this.wires.ready();
		const response = await this.wires.cdp().send("Runtime.evaluate", {
			expression: readVitalsSource(),
			returnByValue: true,
		});
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			return { shifts: [], longTasks: [], paints: {}, error: threw.message };
		}
		return response.result.value as Vitals;
	}
}
