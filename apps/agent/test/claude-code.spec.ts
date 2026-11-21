import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { claudeCodeModelId, parseClaudeCodeId } from "@crm/db/claude-code";
import { claudeCode } from "../agent/lib/claude-code";
import {
	discoverClaudeCodeModels,
	probeContextWindow,
} from "../agent/lib/claude-code-catalog";
import { buildRequest, parseReply } from "../agent/lib/claude-code-prompt";
import {
	modelEvents,
	modelSelection,
	stepModelSelection,
} from "../agent/lib/model";

const sonnet = { model: "sonnet", effort: "high" as const };

const weather: LanguageModelV4CallOptions = {
	prompt: [
		{ role: "system", content: "You research companies." },
		{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "get_weather",
					input: { city: "Paris" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_1",
					toolName: "get_weather",
					output: { type: "json", value: { celsius: 12 } },
				},
			],
		},
	],
	tools: [
		{
			type: "function",
			name: "get_weather",
			description: "Current weather for a city.",
			inputSchema: {
				type: "object",
				properties: { city: { type: "string" } },
				required: ["city"],
			},
		},
	],
};

describe("buildRequest", () => {
	it("puts the tools in the system prompt and the history in the transcript", () => {
		const request = buildRequest(weather);

		expect(request.mode).toBe("tools");
		expect(request.system).toContain("You research companies.");
		expect(request.system).toContain("### get_weather");
		expect(request.transcript).toContain("Weather in Paris?");
		expect(request.transcript).toContain(
			'<tool_call id="call_1" name="get_weather">\n{"city":"Paris"}\n</tool_call>',
		);
		expect(request.transcript).toContain('{"celsius":12}');
		expect(request.schema).toMatchObject({ required: ["text", "toolCalls"] });
	});

	it("sends no schema when no tool is offered", () => {
		const request = buildRequest({ ...weather, tools: [] });

		expect(request.mode).toBe("text");
		expect(request.schema).toBeNull();
	});

	it("drops every tool when the tool choice is none", () => {
		const request = buildRequest({ ...weather, toolChoice: { type: "none" } });

		expect(request.mode).toBe("text");
	});

	it("uses the caller's schema for a JSON response", () => {
		const schema = {
			type: "object" as const,
			properties: { ok: { type: "boolean" as const } },
		};
		const request = buildRequest({
			...weather,
			responseFormat: { type: "json", schema },
		});

		expect(request.mode).toBe("json");
		expect(request.schema).toEqual(schema);
	});

	it("warns about a file it cannot pass on", () => {
		const request = buildRequest({
			prompt: [
				{
					role: "user",
					content: [
						{
							type: "file",
							mediaType: "image/png",
							data: { type: "data", data: "aGk=" },
						},
					],
				},
			],
		} as LanguageModelV4CallOptions);

		expect(request.transcript).toContain("[file omitted: image/png]");
		expect(request.warnings).toContainEqual({
			type: "unsupported",
			feature: "file image/png",
		});
	});
});

describe("parseReply", () => {
	it("turns tool calls into tool-call content", () => {
		const reply = parseReply("tools", "", {
			text: "",
			toolCalls: [{ name: "get_weather", input: { city: "Lyon" } }],
		});

		expect(reply.finishReason.unified).toBe("tool-calls");
		expect(reply.content).toHaveLength(1);
		expect(reply.content[0]).toMatchObject({
			type: "tool-call",
			toolName: "get_weather",
			input: '{"city":"Lyon"}',
		});
	});

	it("returns text and stops when no tool is called", () => {
		const reply = parseReply("tools", "", {
			text: "12 °C in Paris.",
			toolCalls: [],
		});

		expect(reply.finishReason.unified).toBe("stop");
		expect(reply.content).toEqual([{ type: "text", text: "12 °C in Paris." }]);
	});

	it("rejects structured output that does not match the protocol", () => {
		expect(() => parseReply("tools", "", { answer: 1 })).toThrow();
	});
});

describe("Claude Code ids", () => {
	it("round-trips a model and an effort", () => {
		expect(claudeCodeModelId("opus", "max")).toBe("claude-code/opus:max");
		expect(parseClaudeCodeId("claude-code/opus:max")).toEqual({
			model: "opus",
			effort: "max",
		});
		expect(parseClaudeCodeId("claude-code/claude-opus-4-8")).toEqual({
			model: "claude-opus-4-8",
			effort: null,
		});
		expect(parseClaudeCodeId("claude-code/sonnet[1m]")?.model).toBe(
			"sonnet[1m]",
		);
	});

	it("rejects an unknown effort, a flag and a foreign id", () => {
		expect(parseClaudeCodeId("claude-code/opus:ultra")).toBeNull();
		expect(parseClaudeCodeId("claude-code/--dangerously-skip")).toBeNull();
		expect(parseClaudeCodeId("claude-code/opus:high:x")).toBeNull();
		expect(parseClaudeCodeId("anthropic/claude-sonnet-5")).toBeNull();
	});
});

async function withCliPath<T>(
	value: string | undefined,
	run: () => T | Promise<T>,
): Promise<T> {
	const saved = process.env.CLAUDE_CODE_PATH;
	if (value === undefined) delete process.env.CLAUDE_CODE_PATH;
	else process.env.CLAUDE_CODE_PATH = value;
	try {
		return await run();
	} finally {
		if (saved === undefined) delete process.env.CLAUDE_CODE_PATH;
		else process.env.CLAUDE_CODE_PATH = saved;
	}
}

describe("modelSelection", () => {
	it("keeps a gateway id as it is", () => {
		expect(modelSelection("zai/glm-5.2-fast", 1_000)).toEqual({
			model: "zai/glm-5.2-fast",
			modelContextWindowTokens: 1_000,
		});
	});

	it("falls back to the default model when the CLI path is missing", async () => {
		await withCliPath(undefined, () => {
			const selection = modelSelection("claude-code/sonnet", 1_000_000);
			expect(selection.model).not.toContain("claude-code");
		});
	});

	it("falls back on an invalid Claude Code id", async () => {
		await withCliPath("/usr/bin/claude", () => {
			expect(modelSelection("claude-code/opus:ultra", 1).model).not.toContain(
				"claude-code",
			);
		});
	});

	it("keeps a Claude Code id serializable with its stored window", async () => {
		await withCliPath("/usr/bin/claude", () => {
			expect(modelSelection("claude-code/haiku:low", 1_000_000)).toEqual({
				model: "claude-code/haiku:low",
				modelContextWindowTokens: 1_000_000,
			});
		});
	});

	it("builds the live model only at step level", () =>
		withCliPath("/usr/bin/claude", async () => {
			const step = await stepModelSelection({ id: "claude-code/opus:max" });
			expect(step.model).toMatchObject({
				provider: "claude-code",
				modelId: "claude-code/opus:max",
			});
			expect(step.modelContextWindowTokens).toBeGreaterThan(0);
			expect(await stepModelSelection({ id: "zai/glm-5.2-fast" })).toEqual({
				model: "zai/glm-5.2-fast",
			});
		}));

	it("adds a step resolver only with the CLI path", async () => {
		const session = () => modelSelection("zai/glm-5.2-fast", 1);
		await withCliPath("/usr/bin/claude", () => {
			expect(Object.keys(modelEvents(session))).toEqual([
				"session.started",
				"step.started",
			]);
		});
		await withCliPath(undefined, () => {
			expect(Object.keys(modelEvents(session))).toEqual(["session.started"]);
		});
	});
});

describe("the Claude Code CLI", () => {
	let dir: string;

	async function fakeCli(
		name: string,
		body: string,
		filter = "cat",
	): Promise<string> {
		const path = join(dir, name);
		await writeFile(
			path,
			[
				"#!/bin/sh",
				`printf '%s\\n' "$@" > "${dir}/${name}.args"`,
				`cat > "${dir}/${name}.stdin"`,
				`${filter} <<'JSON'`,
				body,
				"JSON",
			].join("\n"),
		);
		await chmod(path, 0o755);
		return path;
	}

	async function argsOf(name: string): Promise<string[]> {
		return (await readFile(join(dir, `${name}.args`), "utf8")).split("\n");
	}

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "claude-code-spec-"));
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const toolResult = JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "",
		session_id: "s1",
		structured_output: {
			text: "",
			toolCalls: [{ name: "get_weather", input: { city: "Nice" } }],
		},
		usage: {
			input_tokens: 3,
			cache_creation_input_tokens: 100,
			cache_read_input_tokens: 50,
			output_tokens: 40,
			output_tokens_details: { thinking_tokens: 10 },
		},
		modelUsage: { "claude-sonnet-5-5": { contextWindow: 1_000_000 } },
	});

	it("runs the CLI bare with the effort and maps its result", async () => {
		const binary = await fakeCli("run", toolResult);
		const result = await claudeCode(sonnet, binary).doGenerate(weather);

		expect(result.finishReason.unified).toBe("tool-calls");
		expect(result.content[0]).toMatchObject({
			type: "tool-call",
			input: '{"city":"Nice"}',
		});
		expect(result.usage.inputTokens.total).toBe(153);
		expect(result.usage.outputTokens).toEqual({
			total: 40,
			text: 30,
			reasoning: 10,
		});

		const args = await argsOf("run");
		expect(args).toContain("--print");
		expect(args).toContain("--strict-mcp-config");
		expect(args).toContain("--no-session-persistence");
		expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
		expect(args[args.indexOf("--effort") + 1]).toBe("high");
		expect(args[args.indexOf("--tools") + 1]).toBe("");
		expect(await readFile(join(dir, "run.stdin"), "utf8")).toContain(
			"Weather in Paris?",
		);
	});

	it("omits the effort flag when none is chosen", async () => {
		const binary = await fakeCli("plain", toolResult);
		await claudeCode({ model: "haiku", effort: null }, binary).doGenerate(
			weather,
		);

		expect(await argsOf("plain")).not.toContain("--effort");
	});

	it("streams the same parts", async () => {
		const binary = await fakeCli("stream", toolResult);
		const { stream } = await claudeCode(sonnet, binary).doStream(weather);
		const types: string[] = [];
		for await (const part of stream) types.push(part.type);

		expect(types[0]).toBe("stream-start");
		expect(types).toContain("tool-call");
		expect(types.at(-1)).toBe("finish");
	});

	it("reports a CLI that cannot start", async () => {
		await expect(
			claudeCode(sonnet, join(dir, "missing")).doGenerate(weather),
		).rejects.toThrow("could not start");
	});

	it("measures the context window from the result", async () => {
		const binary = await fakeCli("probe", toolResult);

		expect(await probeContextWindow(binary, "sonnet")).toBe(1_000_000);
		expect(await probeContextWindow(binary, "--bad")).toBeNull();
	});

	it("lists the models the CLI advertises", async () => {
		const binary = await fakeCli(
			"discover",
			[
				JSON.stringify({ type: "system", subtype: "init" }),
				JSON.stringify({
					type: "control_response",
					response: {
						request_id: "__ID__",
						subtype: "success",
						response: {
							claude_code_version: "2.1.330",
							models: [
								{ value: "default", displayName: "Default" },
								{
									value: "opus",
									resolvedModel: "claude-opus-5-5",
									displayName: "Opus 5.5",
									description: "Complex work",
									supportedEffortLevels: ["low", "high", "max", "turbo"],
								},
								{ value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
								{ value: "--evil", displayName: "Evil" },
							],
						},
					},
				}),
			].join("\n"),
			`sed "s/__ID__/$(sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p' "${dir}/discover.stdin")/"`,
		);

		const catalog = await discoverClaudeCodeModels(binary);

		expect(catalog.version).toBe("2.1.330");
		expect(catalog.models.map((model) => model.model)).toEqual([
			"opus",
			"claude-haiku-4-5",
		]);
		expect(catalog.models[0]).toMatchObject({
			name: "Opus 5.5",
			efforts: ["low", "high", "max"],
			contextWindowTokens: null,
		});
		expect(catalog.models[1]?.efforts).toEqual([]);

		const args = await argsOf("discover");
		expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
	});
});
