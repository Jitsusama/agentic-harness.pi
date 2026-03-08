/**
 * Review loop — generic approve/edit/steer/reject cycle built
 * on top of gate.
 *
 * Parameterized by actions, content renderer, editable fields,
 * command rebuilder, and entity name. Fits all guardian flows:
 *   - approve/edit/reject with single field (commit)
 *   - approve/edit/reject with title+body (PR, issue)
 *   - allow/block without editing (history-guardian)
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { formatSteer, type GateOption, showGate } from "./gate.js";

// ---- Types ----

export interface ReviewAction {
	label: string;
	value: string;
}

/** Single editable text field (e.g., commit message). */
export interface SingleField {
	kind: "single";
	/** Current value. Mutated in-place on edit. */
	value: string;
	/** Prompt shown in the full-screen editor. */
	editorPrompt: string;
}

/** Title + body pair (e.g., PR or issue description). */
export interface TitleBodyField {
	kind: "title-body";
	title: string | null;
	body: string;
	/** Prompt shown in the full-screen editor. */
	editorPrompt: string;
}

export type EditableField = SingleField | TitleBodyField;

export interface ReviewLoopConfig {
	/** Options to present. Steer is auto-appended by gate. */
	actions: ReviewAction[];
	/** Renders the content area. Called on each loop iteration. */
	content: (theme: Theme, width: number) => string[];
	/** Editable field(s). Omit for no-edit flows (history-guardian). */
	field?: EditableField;
	/**
	 * Called on approve to rewrite event.input.command.
	 * Receives the (possibly edited) field. Omit for flows
	 * that don't rewrite commands.
	 */
	onApprove?: (field?: EditableField) => void;
	/** Entity name for messages ("PR", "Issue", "commit", "command"). */
	entityName: string;
	/** Text pre-filled in the steer editor. */
	steerContext: string;
}

export type ReviewResult = { block: true; reason: string } | undefined;

// ---- Loop ----

/**
 * Run the review loop. Shows the gate repeatedly until the
 * user approves, rejects, steers, or cancels.
 */
export async function reviewLoop(
	ctx: ExtensionContext,
	config: ReviewLoopConfig,
): Promise<ReviewResult> {
	const { actions, field, onApprove, entityName } = config;
	let { content, steerContext } = config;

	const hasEdit = actions.some((a) => a.value === "edit") && field;

	while (true) {
		const result = await showGate(ctx, {
			content,
			options: actions as GateOption[],
			steerContext,
		});

		if (!result) {
			return {
				block: true,
				reason: `User cancelled the ${entityName} review.`,
			};
		}

		switch (result.value) {
			case "approve":
			case "allow": {
				onApprove?.(field);
				return;
			}

			case "edit": {
				if (!hasEdit || !field) continue;

				if (field.kind === "single") {
					const edited = await ctx.ui.editor(field.editorPrompt, field.value);
					if (edited?.trim()) {
						field.value = edited;
						// Rebuild content and steer context with new value
						content = config.content;
						steerContext = field.value;
					}
				} else if (field.kind === "title-body") {
					const editContent = [
						field.title ? `# ${field.title}` : null,
						"",
						field.body,
					]
						.filter((l) => l !== null)
						.join("\n");

					const edited = await ctx.ui.editor(field.editorPrompt, editContent);

					if (edited?.trim()) {
						const lines = edited.split("\n");
						if (lines[0]?.startsWith("# ")) {
							field.title = lines[0].replace(/^#\s+/, "");
							field.body = lines.slice(1).join("\n").replace(/^\n+/, "");
						} else {
							field.body = edited;
						}
						// Rebuild steer context with new values
						steerContext = [
							field.title ? `Title: ${field.title}` : null,
							"",
							field.body,
						]
							.filter((l) => l !== null)
							.join("\n");
					}
				}
				continue;
			}

			case "steer":
				return formatSteer(
					result.feedback ?? "",
					`Original ${entityName}:\n${steerContext}`,
				);

			case "block":
				return {
					block: true,
					reason: `User blocked: ${steerContext}`,
				};

			default:
				return {
					block: true,
					reason: `User rejected the ${entityName}. Ask for guidance on the ${entityName} description.`,
				};
		}
	}
}
