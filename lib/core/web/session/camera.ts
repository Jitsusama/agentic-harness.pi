/**
 * Pictures of the page: a screenshot of the viewport, the whole
 * page or one element, held in a state if asked, and a comparison
 * against a baseline recorded earlier.
 *
 * Kept apart from the session because captures are where the
 * session writes to disk, and the rules for where an image lands,
 * how a clip meets the scroll and when a baseline is the wrong
 * subject change for reasons of their own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadOnce } from "../../../internal/single-flight.ts";
import type { Comparison } from "../compare/index.ts";
import {
	type BaselineProvenance,
	describeDrift,
	parse as parseProvenance,
	sidecarFor,
	stringify,
} from "../compare/provenance.ts";
import type { PseudoState } from "../element/index.ts";
import { DIR_MODE, FILE_MODE, pathComponent } from "../envelope/index.ts";
import { defaultBrowserDataRoot } from "../paths.ts";
import { captureTiles } from "../screenshot.ts";
import {
	ambiguityRefusal,
	notFoundRefusal,
	resolveTarget,
} from "../target/index.ts";
import type { ArtifactLedger } from "./artifacts.ts";
import type { EmulationController } from "./emulation.ts";
import type { SessionNodes } from "./nodes.ts";
import type { SessionProbes } from "./probes.ts";
import type { SessionTargeting } from "./targeting.ts";
import type { Shot, ShotOptions, ShotResult } from "./types.ts";
import type { SessionWires } from "./wires.ts";

const imagesModule = loadOnce(() => import("../compare/images.ts"));

/**
 * The image comparison, loaded the first time a session compares or
 * reads a capture. Its PNG codec took 135 to 222 ms to load on 3
 * November, and every pi start paid that while most never look at an
 * image.
 */
export function images(): Promise<typeof import("../compare/images.ts")> {
	return imagesModule();
}

/** What a camera needs of the session it photographs. */
export interface CameraParts {
	/** The node reads a clip and a held state are made from. */
	readonly nodes: SessionNodes;
	/** How a target becomes a node. */
	readonly targeting: SessionTargeting;
	/** The layout a comparison attributes its regions against. */
	readonly probes: SessionProbes;
	/** What the session pretends, which a baseline records. */
	readonly emulation: EmulationController;
	/** Where the session's images are written and kept. */
	readonly artifacts: ArtifactLedger;
	/** The session's name, which its baselines are filed under. */
	readonly name: string;
	/** Where durable artifacts go, when the caller said. */
	readonly dataRoot: string | undefined;
}

/** A session's screenshots and baselines. */
export class SessionCamera {
	/** The live view of the browser the page is photographed through. */
	private readonly wires: SessionWires;

	/** The node reads a clip and a held state are made from. */
	private readonly nodes: SessionNodes;

	/** How a target becomes a node. */
	private readonly targeting: SessionTargeting;

	/** The layout a comparison attributes its regions against. */
	private readonly probes: SessionProbes;

	/** What the session pretends, which a baseline records. */
	private readonly emulation: EmulationController;

	/** Where the session's images are written and kept. */
	private readonly artifacts: ArtifactLedger;

	/** The session's name, which its baselines are filed under. */
	private readonly name: string;

	/** Where durable artifacts go, when the caller said. */
	private readonly dataRoot: string | undefined;

	constructor(wires: SessionWires, parts: CameraParts) {
		this.wires = wires;
		this.nodes = parts.nodes;
		this.targeting = parts.targeting;
		this.probes = parts.probes;
		this.emulation = parts.emulation;
		this.artifacts = parts.artifacts;
		this.name = parts.name;
		this.dataRoot = parts.dataRoot;
	}

	/**
	 * Photograph the page, or one element of it.
	 *
	 * Images never come back inline: a screenshot is far larger
	 * than any response budget and would crowd out the reading it
	 * was meant to illustrate. They go to the session's bundle
	 * directory and the answer carries the paths.
	 *
	 * A full-page capture is tiled, because a long page makes an
	 * image taller than a model will accept. The tiling and its
	 * ceiling are the ones web_read already uses, so a page reads
	 * the same either way.
	 */
	async shoot(options: ShotOptions = {}): Promise<ShotResult> {
		const target = options.target;
		let held: number | undefined;
		try {
			if (target) {
				const tree = await this.targeting.axTree();
				const resolution = resolveTarget(tree, target);
				if (resolution.kind === "notFound") {
					return { ok: false, refusal: notFoundRefusal(tree, target) };
				}
				if (resolution.kind === "ambiguous") {
					return { ok: false, refusal: ambiguityRefusal(tree, target) };
				}
				held = resolution.backendDomId;
			}

			if (options.state !== undefined) {
				await this.holdState(held, options.state);
			}
			return { ok: true, shot: await this.capture(held, options) };
		} finally {
			if (options.state !== undefined) await this.holdState(held, undefined);
		}
	}

	/** Force or release a state for the duration of a capture. */
	private async holdState(
		backendNodeId: number | undefined,
		state: PseudoState | undefined,
	): Promise<void> {
		if (backendNodeId === undefined) return;
		const nodeId = await this.nodes.frontendNodeFor(backendNodeId);
		if (nodeId === undefined) return;
		await this.wires
			.cdp()
			.send("CSS.forcePseudoState", {
				nodeId,
				forcedPseudoClasses: state ? [state] : [],
			})
			// A page that navigated took the forced state with it.
			.catch(() => {});
		const objectId = await this.nodes.objectFor(backendNodeId);
		try {
			// Photographing mid-transition catches a state part way
			// there, which is the one thing a picture must not do.
			if (objectId) await this.nodes.settleForcedState(objectId);
		} finally {
			await this.nodes.release(objectId);
		}
	}

	/** Take the picture and write it out. */
	async capture(
		backendNodeId: number | undefined,
		options: ShotOptions,
	): Promise<Shot> {
		const sink = this.artifacts.sink();
		const stamp = this.artifacts.nextShot();

		const keep = (path: string): string => this.artifacts.keep(path);

		if (backendNodeId !== undefined) {
			const box = await this.nodes.boxOf(backendNodeId);
			const clip = box?.border;
			// The box model measures from the viewport and a screenshot
			// clip is measured from the document, so the two agree only
			// while the page sits at the top. Scrolled, a clip taken
			// straight from the box lands wherever the page has moved
			// from: a picture of the right size, of real content, of the
			// wrong element, with nothing about it to say so.
			const scroll = clip ? await this.nodes.scrollOffset() : undefined;
			const data = await this.wires.page().screenshot({
				type: "png",
				encoding: "base64",
				...(clip
					? {
							clip: {
								x: clip.x + (scroll?.x ?? 0),
								y: clip.y + (scroll?.y ?? 0),
								width: clip.width,
								height: clip.height,
							},
						}
					: {}),
			});
			return {
				paths: [keep(sink.writeBinary(`element-${stamp}.png`, String(data)))],
				truncated: false,
				width: Math.round(clip?.width ?? 0),
				height: Math.round(clip?.height ?? 0),
			};
		}

		if (options.fullPage) {
			const captured = await captureTiles(this.wires.page());
			return {
				paths: captured.tiles.map((tile, index) =>
					keep(
						sink.writeBinary(
							`page-${stamp}-${String(index + 1).padStart(2, "0")}.png`,
							tile,
						),
					),
				),
				truncated: captured.truncated,
				width: 0,
				height: 0,
			};
		}

		const data = await this.wires.page().screenshot({
			type: "png",
			encoding: "base64",
		});
		const seen = await this.nodes.viewport();
		return {
			paths: [keep(sink.writeBinary(`viewport-${stamp}.png`, String(data)))],
			truncated: false,
			width: seen?.width ?? 0,
			height: seen?.height ?? 0,
		};
	}

	/**
	 * Compare the page now against a baseline of it, or record
	 * one when there is none.
	 *
	 * A missing baseline is not a failure. The first run of any
	 * comparison has nothing to compare against, and refusing
	 * would make the tool need a setup step it can perform itself.
	 *
	 * The elements are read after the shot rather than before, so
	 * a region is attributed against the layout that was actually
	 * photographed.
	 */
	async compareToBaseline(
		label: string,
		options: { readonly update?: boolean; readonly threshold?: number } = {},
	): Promise<{
		readonly comparison: Comparison | undefined;
		readonly recorded?: string;
		readonly artifacts: readonly string[];
	}> {
		await this.wires.ready();
		const safe = pathComponent(label);
		const baselinePath = path.join(this.baselineDir(), `${safe}.png`);

		const shot = Buffer.from(
			String(
				await this.wires.page().screenshot({ type: "png", encoding: "base64" }),
			),
			"base64",
		);

		const takenUnder = this.provenance();
		if (options.update || !existsSync(baselinePath)) {
			mkdirSync(path.dirname(baselinePath), {
				recursive: true,
				mode: DIR_MODE,
			});
			writeFileSync(baselinePath, shot, { mode: FILE_MODE });
			writeFileSync(sidecarFor(baselinePath), stringify(takenUnder), {
				mode: FILE_MODE,
			});
			this.artifacts.keep(baselinePath);
			return { comparison: undefined, recorded: baselinePath, artifacts: [] };
		}

		// Refuse rather than diff two different subjects. A baseline
		// recorded before this library stored provenance has none, and
		// is compared as before rather than being thrown away.
		const sidecar = sidecarFor(baselinePath);
		const was = existsSync(sidecar)
			? parseProvenance(readFileSync(sidecar, "utf8"))
			: undefined;
		const differs = was && describeDrift(was, takenUnder);
		if (differs) {
			return {
				comparison: { kind: "incomparable", because: differs },
				artifacts: [],
			};
		}

		// The screenshot is of the viewport; the rects are in
		// document coordinates. The two only coincide at scroll
		// origin, and driving the page before checking it is the
		// loop this tool teaches, so every region was attributed to
		// whatever sat at those coordinates at the top of the page
		// once anything had scrolled.
		const { nodes, viewport } = await this.probes.layout();
		const offsetX = viewport.scrollX ?? 0;
		const offsetY = viewport.scrollY ?? 0;
		const placed = nodes.map((node) => ({
			selector: node.selector,
			rect: {
				...node.rect,
				x: node.rect.x - offsetX,
				y: node.rect.y - offsetY,
			},
		}));

		const { compareImages, readPng } = await images();
		const { comparison, image } = compareImages(
			readPng(readFileSync(baselinePath)),
			readPng(shot),
			placed,
			{
				...(options.threshold === undefined
					? {}
					: { threshold: options.threshold }),
				scale: this.emulation.asked.viewport?.deviceScaleFactor ?? 1,
			},
		);

		if (image === undefined) return { comparison, artifacts: [] };

		// The three together, because a diff on its own shows where
		// something changed and never what it changed from.
		const sink = this.artifacts.sink();
		const stamp = this.artifacts.nextShot();
		const artifacts = [
			sink.writeBinary(
				`${safe}-${stamp}-baseline.png`,
				readFileSync(baselinePath).toString("base64"),
			),
			sink.writeBinary(`${safe}-${stamp}-current.png`, shot.toString("base64")),
			sink.writeBinary(`${safe}-${stamp}-diff.png`, image.toString("base64")),
		];
		for (const artifact of artifacts) this.artifacts.keep(artifact);
		return { comparison, artifacts };
	}

	/**
	 * Where this session's baselines live.
	 *
	 * Under the data directory, not the bundle root. This used to
	 * sit at BUNDLE_ROOT/baselines, which the bundle reaper treats
	 * as an ownerless directory (the name is not a pid) and deletes
	 * once it is six hours old. Writing a baseline touches the
	 * session subdirectory rather than its parent, so the parent's
	 * age kept climbing and a stable set of baselines was reaped on
	 * a timer. The next comparison then found nothing, recorded the
	 * current page as truth and reported a warning, which is data
	 * loss wearing a first run's clothes.
	 *
	 * A baseline is a durable artifact the user asked for and may
	 * want to look at, which is what dataDir is for.
	 */
	private baselineDir(): string {
		// The session name is chosen by whoever is driving. Joined raw,
		// a name of "../../../../tmp/evil" put the baseline write at
		// /Users/tmp/evil: the label beside it was being cleaned and
		// this was not, which is why both now go through one rule.
		return path.join(
			this.dataRoot ?? defaultBrowserDataRoot(),
			"baselines",
			pathComponent(this.name),
		);
	}

	/**
	 * What a baseline was taken under, stored beside the image.
	 *
	 * Without this a comparison cannot tell a regression from a
	 * change of subject: record on one page, navigate to another,
	 * and the diff reports confident failures attributed to the
	 * second page's elements. The size check alone cannot see it,
	 * because two pages at one viewport are the same size.
	 */
	private provenance(): BaselineProvenance {
		const viewport = this.emulation.asked.viewport;
		return {
			url: this.wires.page().url(),
			...(viewport?.width === undefined ? {} : { width: viewport.width }),
			...(viewport?.height === undefined ? {} : { height: viewport.height }),
			deviceScaleFactor: viewport?.deviceScaleFactor ?? 1,
		};
	}
}
