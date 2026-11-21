import { randomUUID } from "node:crypto";
import type {
	JSONSchema7,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4FinishReason,
	LanguageModelV4FunctionTool,
	LanguageModelV4Message,
	LanguageModelV4ToolResultOutput,
	SharedV4Warning,
} from "@ai-sdk/provider";
import { z } from "zod";

export type ClaudeCodeRequest = {
	system: string;
	transcript: string;
	schema: JSONSchema7 | null;
	mode: "text" | "tools" | "json";
	warnings: SharedV4Warning[];
};

type ClaudeCodeReply = {
	content: LanguageModelV4Content[];
	finishReason: LanguageModelV4FinishReason;
};

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "end_turn" };

const toolReply = z.object({
	text: z.string(),
	toolCalls: z.array(
		z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }),
	),
});

function functionTools(
	options: LanguageModelV4CallOptions,
	warnings: SharedV4Warning[],
): LanguageModelV4FunctionTool[] {
	const tools: LanguageModelV4FunctionTool[] = [];
	for (const tool of options.tools ?? []) {
		if (tool.type === "function") tools.push(tool);
		else warnings.push({ type: "unsupported", feature: `tool ${tool.name}` });
	}

	const choice = options.toolChoice ?? { type: "auto" };
	if (choice.type === "none") return [];
	if (choice.type === "tool") {
		return tools.filter((tool) => tool.name === choice.toolName);
	}
	return tools;
}

function toolProtocol(
	tools: LanguageModelV4FunctionTool[],
	required: boolean,
): string {
	const catalog = tools.map((tool) =>
		[
			`### ${tool.name}`,
			tool.description ?? "",
			"Input JSON schema:",
			JSON.stringify(tool.inputSchema),
		].join("\n"),
	);

	return [
		"# How to use the CRM functions",
		"",
		"You run behind an API. The functions listed below are NOT tools you can call.",
		'A direct call to any of them fails with "No such tool available". That error never means the function is missing.',
		"Your only callable tool is the structured reply. It has two fields: `text` and `toolCalls`.",
		"To run functions, end this reply now: put each call in `toolCalls` with its `name` and its `input` object.",
		"The input must match the function's input JSON schema.",
		"The caller runs every call in `toolCalls` and sends each result back in a `<tool_result>` block in the next request.",
		"You then continue from those results. You can request more functions in later replies.",
		"When you need no function, put your whole answer in `text` and leave `toolCalls` empty.",
		required
			? "This reply must contain at least one entry in `toolCalls`."
			: "Request a function only when you need its result.",
		"Never write a function result yourself, and never say a function is unavailable.",
		"",
		"# Functions",
		"",
		...catalog,
	].join("\n");
}

function toolReplySchema(tools: LanguageModelV4FunctionTool[]): JSONSchema7 {
	return {
		type: "object",
		properties: {
			text: { type: "string" },
			toolCalls: {
				type: "array",
				items: {
					type: "object",
					properties: {
						name: { type: "string", enum: tools.map((tool) => tool.name) },
						input: { type: "object" },
					},
					required: ["name", "input"],
				},
			},
		},
		required: ["text", "toolCalls"],
	};
}

function resultText(output: LanguageModelV4ToolResultOutput): string {
	switch (output.type) {
		case "text":
		case "error-text":
			return output.value;
		case "json":
		case "error-json":
			return JSON.stringify(output.value);
		case "execution-denied":
			return `Execution denied${output.reason ? `: ${output.reason}` : "."}`;
		case "content":
			return output.value
				.map((part) =>
					part.type === "text" ? part.text : `[${part.type} omitted]`,
				)
				.join("\n");
	}
}

function block(tag: string, body: string, attributes = ""): string {
	return `<${tag}${attributes}>\n${body}\n</${tag}>`;
}

function toolBlock(
	tag: "tool_call" | "tool_result",
	part: { toolCallId: string; toolName: string },
	body: string,
): string {
	return block(tag, body, ` id="${part.toolCallId}" name="${part.toolName}"`);
}

function systemPrompt(...parts: string[]): string {
	return parts.filter(Boolean).join("\n\n");
}

function renderMessage(
	message: LanguageModelV4Message,
	warnings: SharedV4Warning[],
): string | null {
	switch (message.role) {
		case "system":
			return null;
		case "user": {
			const parts = message.content.map((part) => {
				if (part.type === "text") return part.text;
				warnings.push({
					type: "unsupported",
					feature: `file ${part.mediaType}`,
				});
				return `[file omitted: ${part.mediaType}]`;
			});
			return block("user", parts.join("\n"));
		}
		case "assistant": {
			const parts = message.content.flatMap((part) => {
				if (part.type === "text") return [part.text];
				if (part.type === "tool-call") {
					return [toolBlock("tool_call", part, JSON.stringify(part.input))];
				}
				if (part.type === "tool-result") {
					return [toolBlock("tool_result", part, resultText(part.output))];
				}
				return [];
			});
			return parts.length > 0 ? block("assistant", parts.join("\n")) : null;
		}
		case "tool": {
			const parts = message.content.flatMap((part) =>
				part.type === "tool-result"
					? [toolBlock("tool_result", part, resultText(part.output))]
					: [],
			);
			return parts.length > 0 ? parts.join("\n") : null;
		}
	}
}

export function buildRequest(
	options: LanguageModelV4CallOptions,
): ClaudeCodeRequest {
	const warnings: SharedV4Warning[] = [];

	for (const setting of [
		"temperature",
		"topP",
		"topK",
		"seed",
		"stopSequences",
	] as const) {
		if (options[setting] !== undefined) {
			warnings.push({ type: "unsupported", feature: setting });
		}
	}

	const instructions = options.prompt
		.flatMap((message) => (message.role === "system" ? [message.content] : []))
		.join("\n\n");

	const transcript = options.prompt
		.map((message) => renderMessage(message, warnings))
		.filter((part): part is string => part !== null)
		.join("\n\n");

	if (options.responseFormat?.type === "json") {
		return {
			system: systemPrompt(
				instructions,
				"Reply with one JSON object that matches the requested schema.",
			),
			transcript,
			schema: options.responseFormat.schema ?? { type: "object" },
			mode: "json",
			warnings,
		};
	}

	const tools = functionTools(options, warnings);
	if (tools.length === 0) {
		return {
			system: instructions,
			transcript,
			schema: null,
			mode: "text",
			warnings,
		};
	}

	const required =
		options.toolChoice?.type === "required" ||
		options.toolChoice?.type === "tool";

	return {
		system: systemPrompt(instructions, toolProtocol(tools, required)),
		transcript,
		schema: toolReplySchema(tools),
		mode: "tools",
		warnings,
	};
}

export function parseReply(
	mode: ClaudeCodeRequest["mode"],
	result: string,
	structured: unknown,
): ClaudeCodeReply {
	if (mode === "text") {
		return {
			content: [{ type: "text", text: result }],
			finishReason: STOP,
		};
	}

	if (mode === "json") {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(structured ?? JSON.parse(result)),
				},
			],
			finishReason: STOP,
		};
	}

	const reply = toolReply.parse(structured);
	const content: LanguageModelV4Content[] = [];
	if (reply.text.trim()) content.push({ type: "text", text: reply.text });
	for (const call of reply.toolCalls) {
		content.push({
			type: "tool-call",
			toolCallId: `cc_${randomUUID()}`,
			toolName: call.name,
			input: JSON.stringify(call.input),
		});
	}

	return {
		content,
		finishReason:
			reply.toolCalls.length > 0
				? { unified: "tool-calls", raw: "tool_use" }
				: STOP,
	};
}
