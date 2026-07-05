import { describe, expect, it, vi } from "bun:test";
import {
	setBedrockProviderModule,
	setCursorProviderModule,
	streamBedrock,
	streamCursor,
} from "@oh-my-pi/pi-ai/providers/register-builtins";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function createModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "mock-bedrock",
		name: "Mock Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createAssistantMessage(
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: errorMessage ? `error: ${errorMessage}` : "ok" }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: "mock-bedrock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

const baseContext: Context = { messages: [] };

describe("register-builtins lazy streams", () => {
	it("resolves the outer stream result from source.result() when no terminal event is iterated", async () => {
		const finalMessage = createAssistantMessage("stop");
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream result");
		}
		expect(result).toEqual(finalMessage);
	});

	it("turns iterator failures into terminal error results", async () => {
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				throw new Error("bedrock exploded");
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded error result");
		}
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bedrock exploded");
	});

	it("turns idle lazy provider streams into retryable terminal errors", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, { streamIdleTimeoutMs: 10 });
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});

	it("preserves caller aborts while forwarding lazy provider streams", async () => {
		const abortController = new AbortController();
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, {
			signal: abortController.signal,
			streamIdleTimeoutMs: 500,
		});
		const iterator = stream[Symbol.asyncIterator]();
		const firstEvent = await iterator.next();
		expect(firstEvent.value?.type).toBe("start");

		abortController.abort();
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded caller abort result");
		}
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});

	it("does not race a generic idle watchdog against streamCursor (issue #4593)", async () => {
		// Cursor's exec-channel round-trip legitimately yields no
		// AssistantMessageEvent while OMP runs a local tool for the model.
		// The provider owns h2 heartbeats + trailers, so the lazy wrapper
		// MUST NOT enforce iterateWithIdleTimeout here — otherwise any local
		// tool that runs >120s trips a spurious "Provider stream stalled
		// while waiting for the next event" mid-turn.
		const cursorModel = buildModel({
			id: "mock-cursor",
			name: "Mock Cursor",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const partialMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "cursor-agent",
			provider: "cursor",
			model: "mock-cursor",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const finalMessage: AssistantMessage = { ...partialMessage };

		let providerSignal: AbortSignal | undefined;
		const releaseStall = Promise.withResolvers<void>();
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				// Model back-and-forth silence: mirrors Cursor's exec-channel
				// round-trip where no upstream event arrives until the local
				// tool finishes. If the marker regressed and the wrapper
				// re-armed iterateWithIdleTimeout, the 10ms fake-timer advance
				// below would fire onIdle and abort providerSignal.
				await releaseStall.promise;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;

		setCursorProviderModule({
			streamCursor: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		vi.useFakeTimers();
		try {
			const stream = streamCursor(cursorModel, baseContext, {
				apiKey: "test",
				// Aggressive floor: with PROVIDER_HANDLED_STREAM_TIMEOUTS the
				// wrapper coerces idleTimeoutMs → undefined and never arms a
				// timer. Without the marker, this would fire at 10ms and
				// abort providerSignal with a stalled-stream error.
				streamIdleTimeoutMs: 10,
			});

			// Drain microtasks so the wrapper attaches its iterator and — if
			// the marker regressed — would have armed its idle timer.
			for (let i = 0; i < 20; i++) await Promise.resolve();

			// Advance well past the 10ms floor. Marker present → no timer to
			// fire; marker absent → onIdle fires, abortLocally aborts.
			vi.advanceTimersByTime(10_000);
			for (let i = 0; i < 20; i++) await Promise.resolve();

			expect(providerSignal?.aborted).toBe(false);

			releaseStall.resolve();
			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
