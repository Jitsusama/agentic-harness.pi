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

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatSteer, type GateOption, showGate } from "../ui/gate.js";

// ---- Field types ----

export interface ReviewAction {
	label: string;
	value: string;
}

/** Single editable text field (e.g., commit message). */
export interface SingleField {
	value: string;
	edit(ctx: ExtensionContext): Promise<void>;
	steerText(): string;
}

/** Title + body pair (e.g., PR or issue description). */
export interface TitleBodyField {
	title: string | null;
	body: string;
	edit(ctx: ExtensionContext): Promise<void>;
	steerText(): string;
}

export type EditableField = SingleField | TitleBodyField;

/** Create a single-value editable field. */
export function singleField(value: string, editorPrompt: string): SingleField {
	const field: SingleField = {
		value,
		async edit(ctx: ExtensionContext) {
			const edited = await ctx.ui.editor(editorPrompt, field.value);
			if (edited?.trim()) {
				field.value = edited;
			}
		},
		steerText() {
			return field.value;
		},
	};
	return field;
}

/** Create a title+body editable field. */
export function titleBodyField(
	title: string | null,
	body: string,
	editorPrompt: string,
): TitleBodyField {
	const field: TitleBodyField = {
		title,
		body,
		async edit(ctx: ExtensionContext) {
			const editContent = [
				field.title ? `# ${field.title}` : null,
				"",
				field.body,
			]
				.filter((l) => l !== null)
				.join("\n");

			const edited = await ctx.ui.editor(editorPrompt, editContent);

			if (edited?.trim()) {
				const lines = edited.split("\n");
				if (lines[0]?.startsWith("# ")) {
					field.title = lines[0].replace(/^#\s+/, "");
					field.body = lines.slice(1).join("\n").replace(/^\n+/, "");
				} else {
					field.body = edited;
				}
			}
		},
		steerText() {
			return [field.title ? `Title: ${field.title}` : null, "", field.body]
				.filter((l) => l !== null)
				.join("\n");
		},
	};
	return field;
}

// ---- Config ----

import type { Theme } from "@mariozechner/pi-coding-agent";

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
 *
 * The content function captures the mutable field by reference,
 * so edits are reflected on the next render without reassignment.
 */
export async function reviewLoop(
	ctx: ExtensionContext,
	config: ReviewLoopConfig,
): Promise<ReviewResult> {
	const { actions, content, field, onApprove, entityName } = config;
	let { steerContext } = config;

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
				await field.edit(ctx);
				steerContext = field.steerText();
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
