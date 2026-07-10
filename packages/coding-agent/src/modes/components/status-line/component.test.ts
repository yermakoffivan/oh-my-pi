import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { StatusLineComponent } from "./component";

function makeSessionWithLastMessage(lastMessage: unknown) {
	return {
		messages: [lastMessage],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
	};
}

function makeMutableContextUsageSession(initialTokens: number) {
	let tokens = initialTokens;
	const session = {
		messages: [
			{
				role: "assistant",
				timestamp: 1,
				usage: { totalTokens: 10 },
				content: [],
			},
		],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens, contextWindow: 128000 }),
	};
	return {
		session,
		setTokens(nextTokens: number): void {
			tokens = nextTokens;
		},
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage({
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { offset: 1n, nested: { limit: 2n } },
					},
				],
			}) as unknown as AgentSession,
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("recomputes context tokens after explicit invalidation", () => {
		const { session, setTokens } = makeMutableContextUsageSession(1000);
		const statusLine = new StatusLineComponent(session as unknown as AgentSession);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 1000, contextWindow: 128000 });

		setTokens(250);
		statusLine.invalidate();

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 250, contextWindow: 128000 });
	});
});
