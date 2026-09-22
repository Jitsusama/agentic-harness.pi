/** What a render produced. */
export interface RenderedDiagram {
	readonly pngPath: string;
	readonly svgPath: string;
	readonly base64: string;
}

/** A block of a tool answer: prose, or the picture itself. */
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/**
 * Build the answer for a rendered diagram.
 *
 * The picture is left out unless it was asked for. A rasterized diagram
 * runs to about a hundred thousand tokens, and a tool result is not
 * billed once: it is re-read on every later turn of the session. Sixty
 * nine renders in a month cost $4,644 that way, which was 28 percent of
 * all rent paid on tool results.
 *
 * Nothing is lost by leaving it out. The caller wrote the source, so it
 * already knows what the diagram says, and both files are on disk with
 * the human's viewer usually open on one of them. What the image is
 * genuinely good for is checking a layout the source cannot predict,
 * such as nodes overlapping, and that is worth asking for when it
 * matters rather than paying for every time.
 *
 * The way back is always stated. Dropping bytes is only acceptable when
 * the answer says how to get them, since an agent left guessing spends
 * the saving back finding out.
 */
export function mermaidContent(
	render: RenderedDiagram,
	inline: boolean,
): ContentBlock[] {
	const blocks: ContentBlock[] = [
		{
			type: "text",
			text:
				`Rendered to ${render.svgPath} (svg, crisp at any zoom) and ` +
				`${render.pngPath} (png).`,
		},
	];
	if (inline) {
		blocks.push({
			type: "image",
			data: render.base64,
			mimeType: "image/png",
		});
		return blocks;
	}
	blocks.push({
		type: "text",
		text:
			"The image is not included here, since it costs about a hundred " +
			"thousand tokens for every later turn of the session. Open the " +
			"png with the read tool to look at it, or render again with " +
			"inline set to true when you need to check the layout.",
	});
	return blocks;
}
