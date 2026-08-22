/** Replayable agent transcript and artifact state. UI disclosure lives in runtime. */

export type AgentMessageRole = "visitor" | "agent";
export type ToolCallStatus = "pending" | "running" | "succeeded" | "failed";
export type ThinkingBlockStatus = "active" | "complete";
export type TodoStatus = "pending" | "in-progress" | "completed" | "cancelled";

export interface AgentMessage {
  readonly id: string;
  readonly role: AgentMessageRole;
  readonly text: string;
  readonly responseId: string | null;
}

export interface AgentToolCall {
  readonly id: string;
  readonly title: string;
  readonly input: string;
  readonly output: string;
  readonly status: ToolCallStatus;
}

export interface AgentThinkingBlock {
  readonly id: string;
  readonly text: string;
  readonly status: ThinkingBlockStatus;
}

export interface AgentTodo {
  readonly id: string;
  readonly text: string;
  readonly status: TodoStatus;
}

export type AgentActivity =
  | { readonly status: "idle"; readonly verb: "" }
  | { readonly status: "working"; readonly verb: string };

export interface AuthoredResponseRecord {
  readonly instanceId: string;
  readonly responseId: string;
}

export interface AgentSlice {
  readonly messages: readonly AgentMessage[];
  readonly toolCalls: readonly AgentToolCall[];
  readonly thinkingBlocks: readonly AgentThinkingBlock[];
  readonly todos: readonly AgentTodo[];
  readonly activity: AgentActivity;
  readonly responses: readonly AuthoredResponseRecord[];
}
