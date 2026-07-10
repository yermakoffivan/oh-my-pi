import { beforeAll, describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme();
});

interface EditorSlot {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createEditorSlot(...initial: unknown[]): EditorSlot {
	return {
		children: [...initial],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function createCtx(slot: EditorSlot, editor: unknown) {
	const setFocus = vi.fn();
	const ctx = {
		editor,
		editorContainer: slot,
		ui: {
			setFocus,
			requestRender: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	return { ctx, setFocus };
}

describe("SelectorController.focusActiveEditorArea", () => {
	// Regression for issue #3349: closing a fullscreen overlay (settings,
	// extensions dashboard, agents dashboard) while a hook selector / approval
	// prompt occupies the editor slot must restore focus to that prompt — not
	// to the editor that the prompt replaced. Pre-fix, the close handlers
	// hardcoded `setFocus(this.ctx.editor)`, leaving keystrokes routed to a
	// no-longer-mounted editor while the visible prompt sat unreachable.

	it("focuses the editor when the slot has only the editor in it", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot(editor);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
	});

	it("focuses the active hook-selector-style prompt when the slot holds it instead of the editor", () => {
		const editor = { id: "editor" };
		const approvalPrompt = { id: "approval-prompt" };
		// Mirrors `ExtensionUiController.showHookSelector`: the hook surface
		// clears the slot and replaces the editor with its prompt component.
		const slot = createEditorSlot(approvalPrompt);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(approvalPrompt);
		expect(setFocus).not.toHaveBeenCalledWith(editor);
	});

	it("falls back to the editor when the slot is empty (defensive)", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot();
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
	});
});

describe("SelectorController.showSelector disposal", () => {
	it("disposes the selector exactly once when the close callback restores the editor", () => {
		const editor = { id: "editor", dispose: vi.fn(), render: () => [] };
		const selector = { id: "selector", dispose: vi.fn(), render: () => [] };
		const slot = createEditorSlot(editor);
		const { ctx, setFocus } = createCtx(slot, editor);
		let closeSelector: (() => void) | undefined;

		new SelectorController(ctx).showSelector(done => {
			closeSelector = done;
			return { component: selector, focus: selector };
		});

		expect(slot.children).toEqual([selector]);
		expect(setFocus).toHaveBeenLastCalledWith(selector);

		closeSelector?.();
		closeSelector?.();

		expect(selector.dispose).toHaveBeenCalledTimes(1);
		expect(editor.dispose).not.toHaveBeenCalled();
		expect(slot.children).toEqual([editor]);
		expect(setFocus).toHaveBeenLastCalledWith(editor);
	});

	it("disposes a non-editor component occupying the editor slot before showing a selector", () => {
		const editor = { id: "editor", dispose: vi.fn(), render: () => [] };
		const stalePrompt = { id: "stale-prompt", dispose: vi.fn(), render: () => [] };
		const selector = { id: "selector", dispose: vi.fn(), render: () => [] };
		const slot = createEditorSlot(stalePrompt);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).showSelector(() => {
			return { component: selector, focus: selector };
		});

		expect(stalePrompt.dispose).toHaveBeenCalledTimes(1);
		expect(editor.dispose).not.toHaveBeenCalled();
		expect(selector.dispose).not.toHaveBeenCalled();
		expect(slot.children).toEqual([selector]);
		expect(setFocus).toHaveBeenLastCalledWith(selector);
	});
});
