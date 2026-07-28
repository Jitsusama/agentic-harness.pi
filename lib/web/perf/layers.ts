/**
 * What the page asked the compositor to keep.
 *
 * A composited layer is a texture the GPU holds so that moving or
 * fading the thing on it costs no repaint. That trade runs both
 * ways: too little promotion and an animating element repaints
 * every frame, too much and the page holds tens of megabytes of
 * texture it never needed.
 *
 * Everything here is Chrome's own account. The layer list arrives
 * on LayerTree.layerTreeDidChange and the reason for each layer
 * comes from LayerTree.compositingReasons. No reason is ever
 * synthesized: measured against Chrome 141, that API returns an
 * empty list for a genuinely promoted layer, so silence is
 * reported as silence rather than turned into a guess or, worse,
 * into a claim the layer was not promoted at all.
 */

/** Four bytes to a pixel, which is how a texture is sized. */
export const BYTES_PER_PIXEL = 4;

/** How many layers to name before the tail is only counted. */
const LISTED_LAYERS = 12;

/**
 * How long to let the compositor finish reporting after a frame.
 *
 * The tree arrives asynchronously and in more than one instalment
 * on a busy page, so a read that returns immediately catches a
 * partial tree.
 */
export const LAYER_SETTLE_MS = 600;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/** One layer, as Chrome reports it. */
export interface RawLayer {
	readonly layerId: string;
	readonly parentLayerId?: string;
	/** The element this layer was made for, when Chrome names one. */
	readonly backendNodeId?: number;
	readonly width: number;
	readonly height: number;
	readonly paintCount: number;
	readonly drawsContent: boolean;
}

/** A capture of the layer tree and what Chrome said about it. */
export interface LayerFacts {
	readonly layers: readonly RawLayer[];
	/** Chrome's reasons per layer id, which may legitimately be empty. */
	readonly reasons: Readonly<Record<string, readonly string[]>>;
	/** How to name the element behind a layer, per layer id. */
	readonly elements: Readonly<Record<string, string>>;
}

/** One layer, folded and ready to report. */
export interface CompositedLayer {
	readonly id: string;
	readonly element?: string;
	readonly width: number;
	readonly height: number;
	readonly paintCount: number;
	readonly drawsContent: boolean;
	/** Texture bytes, which is zero for a layer that draws nothing. */
	readonly memoryBytes: number;
	readonly reasons: readonly string[];
	/**
	 * Whether Chrome made this layer for an element.
	 *
	 * The tree also carries structural layers of its own, the root
	 * and the visual viewport among them. Those were never a
	 * promotion decision anybody made, so asking why they exist is
	 * the wrong question to put to them.
	 */
	readonly forElement: boolean;
}

/** How many layers share one reason. */
export interface ReasonTally {
	readonly reason: string;
	readonly count: number;
}

/** What the compositor is holding for this page. */
export interface LayerReport {
	/** Every layer, heaviest first. */
	readonly layers: readonly CompositedLayer[];
	/** How many of them actually paint something. */
	readonly drawing: number;
	/** Texture bytes across the layers that draw. */
	readonly memoryBytes: number;
	/** Layers Chrome gave no reason for. */
	readonly unexplained: number;
	/** Reasons, in order of how many layers each accounts for. */
	readonly byReason: readonly ReasonTally[];
}

/**
 * Name an element compactly, the way a developer would say it.
 *
 * Chrome hands back a tag name and a flat array of alternating
 * attribute names and values. A tag with its id, or failing that
 * its first class, is enough to find the thing again without
 * quoting a whole selector path.
 */
export function nameNode(
	nodeName: string,
	attributes: readonly string[] = [],
): string {
	const tag = nodeName.toLowerCase();
	const read = (wanted: string): string | undefined => {
		for (let index = 0; index + 1 < attributes.length; index += 2) {
			if (attributes[index] === wanted) return attributes[index + 1];
		}
		return undefined;
	};
	const id = read("id");
	if (id) return `${tag}#${id}`;
	const classes = read("class")?.trim().split(/\s+/).filter(Boolean) ?? [];
	if (classes.length > 0) return `${tag}.${classes[0]}`;
	return tag;
}

/**
 * Texture bytes for one layer.
 *
 * A layer that draws no content holds no texture however large its
 * bounds are: the viewport and scrolling layers come back at the
 * full page size with drawsContent false, and counting those would
 * bill the page several megabytes it never paid.
 */
function memoryOf(layer: RawLayer): number {
	if (!layer.drawsContent) return 0;
	return Math.max(0, layer.width) * Math.max(0, layer.height) * BYTES_PER_PIXEL;
}

/** Fold a layer tree capture into what it costs and why it exists. */
export function foldLayers(facts: LayerFacts): LayerReport {
	const layers: CompositedLayer[] = facts.layers.map((layer) => {
		const reasons = facts.reasons[layer.layerId] ?? [];
		const element = facts.elements[layer.layerId];
		return {
			id: layer.layerId,
			...(element === undefined ? {} : { element }),
			width: layer.width,
			height: layer.height,
			paintCount: layer.paintCount,
			drawsContent: layer.drawsContent,
			memoryBytes: memoryOf(layer),
			reasons,
			forElement: layer.backendNodeId !== undefined,
		};
	});
	// Heaviest first, because the layer worth arguing about is the one
	// holding the most texture, not the one Chrome happened to list
	// first.
	layers.sort((a, b) => b.memoryBytes - a.memoryBytes);

	const counts = new Map<string, number>();
	let unexplained = 0;
	for (const layer of layers) {
		if (layer.reasons.length === 0) {
			// Only an element's layer counts as unexplained. Chrome's own
			// structural layers carry no reason because no promotion
			// decision produced them, and counting those would report a
			// mystery on every page including a clean one.
			if (layer.forElement) unexplained += 1;
			continue;
		}
		for (const reason of layer.reasons) {
			counts.set(reason, (counts.get(reason) ?? 0) + 1);
		}
	}

	return {
		layers,
		drawing: layers.filter((layer) => layer.memoryBytes > 0).length,
		memoryBytes: layers.reduce((total, layer) => total + layer.memoryBytes, 0),
		unexplained,
		byReason: [...counts]
			.map(([reason, count]) => ({ reason, count }))
			.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
	};
}

/** Bytes as something a person reads without counting digits. */
function size(bytes: number): string {
	if (bytes >= BYTES_PER_MB) {
		return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
	}
	return `${Math.round(bytes / BYTES_PER_KB)} KB`;
}

/** Report what the compositor holds and what put it there. */
export function renderLayers(report: LayerReport): string {
	if (report.layers.length === 0) {
		return (
			"No composited layers. Nothing on this page asked the " +
			"compositor for a texture of its own."
		);
	}

	const lines: string[] = [];
	const many = report.layers.length === 1 ? "layer" : "layers";
	lines.push(
		`${report.layers.length} ${many}, ${report.drawing} drawing ` +
			`content, holding ${size(report.memoryBytes)} of texture.`,
	);

	if (report.unexplained > 0) {
		// Said plainly, because the alternative reading is the damaging
		// one: these layers exist, and Chrome declining to explain them
		// is not the same as their not being promoted.
		const was = report.unexplained === 1 ? "layer" : "layers";
		lines.push(
			`Chrome gave no reason for ${report.unexplained} ${was}. ` +
				"They are promoted; its compositingReasons simply came back " +
				"empty, so nothing here can say what put them there.",
		);
	}

	if (report.byReason.length > 0) {
		lines.push("");
		lines.push("Why they exist:");
		for (const entry of report.byReason) {
			lines.push(`  ${entry.count} x ${entry.reason}`);
		}
	}

	lines.push("");
	lines.push("Heaviest first:");
	for (const layer of report.layers.slice(0, LISTED_LAYERS)) {
		const where = layer.element ?? `layer ${layer.id}`;
		const drawn = layer.drawsContent
			? `${size(layer.memoryBytes)}, painted ${layer.paintCount}x`
			: "draws nothing, so holds no texture";
		lines.push(
			`  ${where}: ${Math.round(layer.width)} by ` +
				`${Math.round(layer.height)}, ${drawn}`,
		);
	}
	const hidden = report.layers.length - LISTED_LAYERS;
	if (hidden > 0) {
		lines.push(`  and ${hidden} more.`);
	}

	return lines.join("\n");
}
