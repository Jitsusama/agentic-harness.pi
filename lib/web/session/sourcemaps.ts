/**
 * Which source map belongs to which file, and what that makes
 * of a generated position.
 *
 * Chrome reports the map's URL and stops there. It does no
 * resolving of its own, because in a browser that is the
 * devtools front end's job, so a session that wants authored
 * positions has to keep the note itself. The note is all that
 * is kept eagerly: most sessions never throw, and fetching every
 * map a page mentions would cost a request per bundle to answer
 * a question nobody asked.
 */

import type { EvalFrame } from "../evaluate/index.js";
import {
	type AuthoredPosition,
	authoredPosition,
	parseSourceMap,
	resolveMapUrl,
	type SourceMap,
} from "../sourcemap/index.js";
import type { SessionWires } from "./wires.js";

/** The maps a page has declared, fetched only when asked after. */
export class SourceMapStore {
	/** Which map each script and stylesheet named, unresolved. */
	private readonly mapUrls = new Map<string, string>();

	/** Maps already fetched. A null records one that will not come. */
	private readonly maps = new Map<string, SourceMap | null>();

	/** Which URL each stylesheet id belongs to. */
	private readonly sheetUrls = new Map<string, string>();

	constructor(private readonly wires: SessionWires) {}

	/**
	 * Note which map belongs to which script and stylesheet, from
	 * here on.
	 */
	async listen(): Promise<void> {
		this.wires.cdp().on("Debugger.scriptParsed", (event) => {
			if (!event.sourceMapURL || !event.url) return;
			this.mapUrls.set(event.url, event.sourceMapURL);
		});
		this.wires.cdp().on("CSS.styleSheetAdded", (event) => {
			const { sourceURL, sourceMapURL, styleSheetId } = event.header;
			if (!sourceMapURL || !sourceURL) return;
			this.mapUrls.set(sourceURL, sourceMapURL);
			// The cascade names a stylesheet by id, not by URL, so the
			// two have to be joined here while both are in hand.
			this.sheetUrls.set(styleSheetId, sourceURL);
		});
		await this.wires.cdp().send("Debugger.enable");
	}

	/**
	 * Tell each frame of a stack where it was written.
	 *
	 * A frame with no map keeps its generated position rather than
	 * being dropped: half a stack is worse than a raw one.
	 */
	async resolveFrames(
		frames: readonly EvalFrame[],
	): Promise<readonly EvalFrame[]> {
		return Promise.all(
			frames.map(async (frame) => {
				if (!frame.url) return frame;
				const map = await this.mapFor(frame.url);
				if (!map) return frame;
				const authored = authoredPosition(map, {
					line: frame.lineNumber,
					column: frame.columnNumber,
				});
				return authored === undefined ? frame : { ...frame, authored };
			}),
		);
	}

	/**
	 * Where a stylesheet position was authored, or nothing when no
	 * map covers it.
	 *
	 * The cascade names its stylesheet by protocol id, so the join
	 * from id to URL to map happens here, where all three notes
	 * live.
	 */
	async authoredForSheet(
		styleSheetId: string,
		position: { readonly line: number; readonly column: number },
	): Promise<AuthoredPosition | undefined> {
		const url = this.sheetUrls.get(styleSheetId);
		if (url === undefined) return undefined;
		const map = await this.mapFor(url);
		if (!map) return undefined;
		return authoredPosition(map, position);
	}

	/**
	 * Fetch and decode the map for a file, once.
	 *
	 * The fetch goes through the page rather than through node,
	 * because the page is already on the right origin with the
	 * right cookies. A map behind a login is unreachable any
	 * other way.
	 *
	 * A failure is cached as firmly as a success. A map that 404s
	 * will still 404 on the next frame of the same stack, and
	 * asking again once per frame is how one bad path turns into
	 * a dozen requests.
	 */
	private async mapFor(fileUrl: string): Promise<SourceMap | undefined> {
		const cached = this.maps.get(fileUrl);
		if (cached !== undefined) return cached ?? undefined;

		const declared = this.mapUrls.get(fileUrl);
		if (!declared) return undefined;
		const located = resolveMapUrl(fileUrl, declared);
		if (!located) {
			this.maps.set(fileUrl, null);
			return undefined;
		}

		let json: string | undefined;
		if (located.kind === "inline") {
			json = located.json;
		} else {
			try {
				const response = await this.wires.cdp().send("Runtime.evaluate", {
					expression: `fetch(${JSON.stringify(located.url)})
						.then((r) => (r.ok ? r.text() : null))
						.catch(() => null)`,
					awaitPromise: true,
					returnByValue: true,
				});
				const body = response.result.value;
				if (typeof body === "string") json = body;
			} catch {
				// A page that navigated away mid-fetch is not a reason
				// to lose the stack we were annotating.
			}
		}

		const parsed = json === undefined ? undefined : parseSourceMap(json);
		this.maps.set(fileUrl, parsed ?? null);
		return parsed;
	}
}
