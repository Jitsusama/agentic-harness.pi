/**
 * Mermaid Widget Extension
 *
 * Registers a `render_mermaid` tool that turns Mermaid diagram source
 * into two artifacts: a crisp SVG and a PNG scaled to the vision-model
 * pixel budget. The agent calls it in conversation ("draw this as a
 * diagram"); there is no command. Rendering reuses the shared headless
 * browser from agentic-harness.core's web library, so it inherits
 * that hardened lifecycle rather than managing its own browser.
 *
 * The result carries the PNG path (portable raster, and the inline image
 * a vision model sees), the SVG path (crisp vector, the human's readable
 * copy) and the image inline. When a human is at an interactive session,
 * the PNG is opened in the OS image viewer: neither the terminal content
 * viewer nor an nvim text buffer can display a diagram, and the viewer
 * renders the high-resolution PNG reliably. The SVG path is returned
 * alongside for when a diagram is dense enough to want infinite zoom in
 * a browser.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	MermaidRenderError,
	renderMermaid,
} from "@jitsusama/agentic-harness.core/web/mermaid";
import { Type } from "@sinclair/typebox";
import { drawInto, firstText } from "../../lib/ui/index.ts";
import { mermaidContent } from "./content.ts";

/** The platform command that opens a file in its default app. */
function osOpenCommand(): { command: string; args: string[] } | null {
	switch (platform()) {
		case "darwin":
			return { command: "open", args: [] };
		case "win32":
			return { command: "cmd", args: ["/c", "start", ""] };
		case "linux":
			return { command: "xdg-open", args: [] };
		default:
			return null;
	}
}

/**
 * Open a rendered PNG in the OS image viewer, detached and best-effort.
 * A PNG maps to an image viewer on every desktop, so this is reliable in
 * a way that opening the SVG is not (the default .svg handler is often a
 * text editor). A missing opener or a spawn failure is ignored: the file
 * paths are still in the result for the user.
 */
function openInViewer(filePath: string): void {
	const opener = osOpenCommand();
	if (!opener) return;
	try {
		const child = spawn(opener.command, [...opener.args, filePath], {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {
			// No opener on PATH; the returned paths are the fallback.
		});
		child.unref();
	} catch {
		// Spawn refused; the returned paths are the fallback.
	}
}

/** Details returned by render_mermaid. */
interface MermaidDetails {
	pngPath?: string;
	svgPath?: string;
	error?: string;
}

/** Type guard for a successful render. */
function isSuccess(
	details: unknown,
): details is { pngPath: string; svgPath: string } {
	if (typeof details !== "object" || details === null) return false;
	const d: Partial<MermaidDetails> = details;
	return typeof d.pngPath === "string" && typeof d.svgPath === "string";
}

/** Register the render_mermaid tool and its interactive viewer. */
export default function mermaidWidget(pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | null = null;
	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
	});

	pi.registerTool({
		name: "render_mermaid",
		label: "Render Mermaid",
		description:
			"Render Mermaid diagram source to a crisp SVG plus a PNG, and " +
			"answer with both paths. The image is not returned inline unless " +
			"'inline' is set, because a rasterized diagram costs about a " +
			"hundred thousand tokens on every later turn of the session. Use " +
			"when asked to draw or visualize something as a diagram, or to " +
			"embed a diagram in a quest planning document.",
		promptSnippet:
			"Render Mermaid source to an SVG plus a PNG, answering with paths.",
		promptGuidelines: [
			"Use render_mermaid to turn Mermaid source into a diagram rather than leaving it as prose.",
			"It writes two files: an SVG (crisp at any zoom, for humans to read) and a PNG (the inline image and a portable raster) beside it.",
			"To embed a diagram in a quest document, pass an explicit PNG path inside that quest's attachments/ folder and link it from the document; the SVG lands next to it with the same base name.",
			"Embed the PNG in markdown for portability; point a human at the SVG when they need to read a dense diagram closely.",
			"You wrote the source, so you already know what the diagram says: do not ask for it inline just to confirm it rendered. Set inline only to check something the source cannot predict, such as whether nodes overlap.",
			"Rendering needs internet access to load the Mermaid library.",
		],
		parameters: Type.Object({
			source: Type.String({ description: "Mermaid diagram source" }),
			path: Type.Optional(
				Type.String({
					description: "Output PNG path. Defaults to a temp file when omitted.",
				}),
			),
			inline: Type.Optional(
				Type.Boolean({
					description:
						"Return the rendered image itself, not just its path. Costs " +
						"about a hundred thousand tokens, re-read on every later " +
						"turn, so ask only to check a layout the source cannot " +
						"predict.",
				}),
			),
		}),

		renderCall(args, theme, context) {
			const label = theme.fg("toolTitle", theme.bold("render_mermaid "));
			const firstLine = args.source.split("\n")[0] ?? "";
			return drawInto(
				context?.lastComponent,
				label + theme.fg("dim", firstLine),
			);
		},

		renderResult(result, _options, theme, context) {
			const text = firstText(result);
			if (!isSuccess(result.details)) {
				return drawInto(context?.lastComponent, theme.fg("error", text));
			}
			return drawInto(
				context?.lastComponent,
				theme.fg("success", "\u2713 ") +
					theme.fg("dim", `${result.details.svgPath} (svg)`) +
					theme.fg("dim", `  ${result.details.pngPath} (png)`),
			);
		},

		async execute(_toolCallId, params) {
			try {
				const { pngPath, svgPath, base64 } = await renderMermaid(
					params.source,
					params.path,
				);
				// Show it to the human when a UI is attached; skip for
				// subagent, print and RPC runs, which have no local display
				// and only want the payload. hasUI is the runtime's signal
				// for an interactive session.
				if (ctxRef?.hasUI) openInViewer(pngPath);
				return {
					content: mermaidContent(
						{ pngPath, svgPath, base64 },
						params.inline === true,
					),
					details: { pngPath, svgPath } satisfies MermaidDetails,
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
