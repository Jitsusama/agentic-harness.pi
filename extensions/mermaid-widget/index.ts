/**
 * Mermaid Widget Extension
 *
 * Registers a `render_mermaid` tool that turns Mermaid diagram source
 * into a rendered PNG. The agent calls it in conversation ("draw this as
 * a diagram"); there is no command. Rendering reuses the shared headless
 * browser from lib/web, so it inherits that hardened lifecycle rather
 * than managing its own browser.
 *
 * The result carries both the PNG file path (to open or embed in a quest
 * document) and the image inline, so a vision model can see the diagram.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { MermaidRenderError, renderMermaid } from "../../lib/web/mermaid.js";

/** Details returned by render_mermaid. */
interface MermaidDetails {
	pngPath?: string;
	error?: string;
}

/** Type guard for a successful render. */
function isSuccess(details: unknown): details is { pngPath: string } {
	return (
		typeof details === "object" &&
		details !== null &&
		"pngPath" in details &&
		typeof (details as Record<string, unknown>).pngPath === "string"
	);
}

export default function mermaidWidget(pi: ExtensionAPI) {
	pi.registerTool({
		name: "render_mermaid",
		label: "Render Mermaid",
		description:
			"Render Mermaid diagram source to a PNG image. Returns the file " +
			"path and the rendered diagram inline. Use when asked to draw or " +
			"visualize something as a diagram, or to embed a diagram in a " +
			"quest planning document.",
		promptSnippet:
			"Render Mermaid source to a PNG diagram (file path plus inline image).",
		promptGuidelines: [
			"Use render_mermaid to turn Mermaid source into a diagram rather than leaving it as prose.",
			"Pass an explicit path to write the PNG beside a quest document you want to embed it in.",
			"Rendering needs internet access to load the Mermaid library.",
		],
		parameters: Type.Object({
			source: Type.String({ description: "Mermaid diagram source" }),
			path: Type.Optional(
				Type.String({
					description: "Output PNG path. Defaults to a temp file when omitted.",
				}),
			),
		}),

		renderCall(args, theme) {
			const label = theme.fg("toolTitle", theme.bold("render_mermaid "));
			const firstLine = args.source.split("\n")[0] ?? "";
			return new Text(label + theme.fg("dim", firstLine), 0, 0);
		},

		renderResult(result, _options, theme) {
			const first = result.content?.[0];
			const text = first && first.type === "text" ? first.text : "";
			if (!isSuccess(result.details)) {
				return new Text(theme.fg("error", text), 0, 0);
			}
			return new Text(
				theme.fg("success", "\u2713 ") +
					theme.fg("dim", result.details.pngPath),
				0,
				0,
			);
		},

		async execute(_toolCallId, params) {
			try {
				const { pngPath, base64 } = await renderMermaid(
					params.source,
					params.path,
				);
				return {
					content: [
						{ type: "text" as const, text: `Rendered diagram to ${pngPath}` },
						{ type: "image" as const, data: base64, mimeType: "image/png" },
					],
					details: { pngPath },
				};
			} catch (err: unknown) {
				const msg =
					err instanceof MermaidRenderError
						? err.message
						: err instanceof Error
							? err.message
							: String(err);
				return {
					content: [{ type: "text" as const, text: `Render failed: ${msg}` }],
					details: { error: msg } satisfies MermaidDetails,
				};
			}
		},
	});
}
