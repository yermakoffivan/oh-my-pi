/**
 * Task tool renderer export.
 *
 * Separated from render.ts to avoid circular dependency issues with
 * tools/renderers.ts. This module has no side effects and can be safely
 * imported without triggering the subprocessToolRegistry registration.
 */
import { renderCall, renderResult } from "./render";

type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function hasTimeBasedProgress(value: unknown): boolean {
	if (!isRecord(value) || value.status !== "running") return false;
	if (isRecord(value.retryState)) return true;
	return typeof value.currentTool === "string" && typeof value.currentToolStartMs === "number";
}

function timeBasedPartialResult(_args: unknown, result: { details?: unknown }): boolean {
	const details = result.details;
	if (!isRecord(details) || !Array.isArray(details.progress)) return false;
	return details.progress.some(hasTimeBasedProgress);
}

export const taskToolRenderer = {
	renderCall,
	renderResult,
	mergeCallAndResult: true,
	timeBasedPartialResult,
} as const;
