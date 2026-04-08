import { ChatOllama } from "@langchain/ollama";
import { OLLAMA } from "./config.js";
import { TOOLS } from "./tools.js";
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildSystemPrompt } from "./prompt.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { randomUUID } from "node:crypto";


const llm = new ChatOllama({
    model: OLLAMA.model,
    temperature: 0.1,
}).bindTools(TOOLS);

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function normalizePseudoToolJson(content: string): string {
    return content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        // Some models emit ISO dates without quotes, which breaks JSON parsing.
        .replace(/("date"\s*:\s*)(\d{4}-\d{2}-\d{2})(?=\s*[,}])/g, '$1"$2"');
}

function extractFallbackToolCall(content: unknown) {
    // console.log("Fallback");
    if (typeof content !== "string" || content.trim() === "") {
        return null;
    }

    const normalized = normalizePseudoToolJson(content);

    try {
        const parsed = JSON.parse(normalized);
        if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            typeof parsed.name !== "string" ||
            !TOOL_NAMES.has(parsed.name) ||
            !parsed.parameters ||
            typeof parsed.parameters !== "object" ||
            Array.isArray(parsed.parameters)
        ) {
            return null;
        }

        return {
            name: parsed.name,
            args: parsed.parameters,
            id: randomUUID(),
            type: "tool_call" as const,
        };
    } catch {
        return null;
    }
}


// Calls the LLM with current message history and return its response
async function agentNode(state: typeof MessagesAnnotation.State) {
    const system = new SystemMessage(buildSystemPrompt());
    const response = await llm.invoke([system, ...state.messages]);
    const fallbackToolCall =
        (!Array.isArray(response.tool_calls) || response.tool_calls.length === 0)
            ? extractFallbackToolCall(response.content)
            : null;

    if (fallbackToolCall) {
        return {
            messages: [
                new AIMessage({
                    content: "",
                    tool_calls: [fallbackToolCall],
                }),
            ],
        };
    }

    return { messages: [response] };
}

// Calls the tools and returns the result
const toolNode = new ToolNode(TOOLS);

// If last message has tool calls, go to "tools", else end
function shouldContinue(state: typeof MessagesAnnotation.State): "tools" | typeof END {
    const lastMessage = state.messages.at(-1);
    if (lastMessage && "tool_calls" in lastMessage && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0) {
        return "tools";
    }
    else {
        return END;
    }
}

// Graph
const checkpointer = new MemorySaver();

const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent")
    .compile({ checkpointer });

export async function runAgent(
    userMessage: string,
    credentials: unknown,
    sessionId?: string
) {
    const threadId =
        typeof sessionId === "string" && sessionId.trim() !== ""
            ? sessionId.trim()
            : randomUUID();

    const config = {
        configurable: {
            thread_id: threadId,
            credentials,
        }
    };

    const result = await graph.invoke(
        { messages: [new HumanMessage(userMessage)] },
        config
    );

    const lastMessage = result.messages.at(-1);
    const response =
        typeof lastMessage?.content === "string"
            ? lastMessage.content.trim()
            : "(No response generated)";

    const tools_used = result.messages.flatMap((message) => {
        if ("tool_calls" in message && Array.isArray(message.tool_calls)) {
            return message.tool_calls
                .map((toolCall) => toolCall?.name)
                .filter((name): name is string => typeof name === "string" && name.trim() !== "");
        }
        return [];
    });

    return {
        session_id: threadId,
        response,
        tools_used: [...new Set(tools_used)],
        errors: [] as { service: string; reason: string }[],
    };
}

export function endSession(_sessionId?: string): boolean {
    return true;
}
