import { ChatOllama } from "@langchain/ollama";
import { OLLAMA } from "./config.js";
import { TOOLS } from "./tools.js";
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildSystemPrompt } from "./prompt.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { randomUUID } from "node:crypto";


const llm = new ChatOllama({
    model: OLLAMA.model,
    temperature: 0.1,
}).bindTools(TOOLS);


// Calls the LLM with current message history and return its response
async function agentNode(state: typeof MessagesAnnotation.State) {
    const system = new SystemMessage(buildSystemPrompt());
    const response = await llm.invoke([system, ...state.messages]);
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

    return {
        session_id: threadId,
        response,
        tools_used: [] as string[],
        errors: [] as { service: string; reason: string }[],
    };
}

export function endSession(_sessionId?: string): boolean {
    return true;
}

