import type { AgentEvent } from '@opcai/contracts';

/**
 * Canonical domain records owned by the orchestration service.
 *
 * These deliberately mirror the shapes the Vue renderer already uses
 * (conversation/chat message/project/task) so desktop UI and future channel /
 * relay gateways map onto the same state machine with minimal friction.
 */

/* ------------------------------------------------------------------ *
 * Chat sessions (普通对话)
 * ------------------------------------------------------------------ */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** Turn id — the user message that started the exchange. */
  turnId?: string;
  /** Run attempt that produced this assistant message. */
  runId?: string;
  /** Older attempts of the same turn are hidden from the canonical view. */
  superseded?: boolean;
}

export type GrantCapability = 'workspace-write' | 'script-execution' | 'network-access';

/**
 * Derived session rolling memory. Transcript (`messages`) remains the source of
 * truth; this summary is rebuildable and may lag until the next roll/flush.
 */
export interface SessionMemory {
  /** Rolling continuity brief for reopen / context assembly. */
  summary: string;
  /** Last message id fully absorbed into `summary` (canonical view). */
  coveredUntilId: string;
  updatedAt: number;
  /** True when new turns exist beyond the watermark and may need a flush. */
  dirty: boolean;
}

export interface ChatSession {
  id: string;
  kind: 'chat';
  title: string;
  /** Currently selected employee for this session. */
  employeeId: string;
  /** Currently selected model (client-resolved, non-secret label payload). */
  modelLabel?: string;
  messages: ChatMessage[];
  /** Rolling summary for long chats; optional until first roll/flush. */
  memory?: SessionMemory;
  /** Future channel binding, e.g. channel:telegram:<chatId>. */
  channelBinding?: { channelId: string; threadId: string } | null;
  /** Per-session approvals granted this run (skillId -> capabilities). */
  grantsSession: Record<string, GrantCapability[]>;
  /** Persistent approvals (skillId -> capabilities). */
  grantsAlways: Record<string, GrantCapability[]>;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ *
 * Agent runs (可续跑 run 语义)
 * ------------------------------------------------------------------ */

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting-approval';

export interface RunActivity {
  toolName: string;
  summary: string;
  status: 'running' | 'completed' | 'failed';
  at: number;
}

export interface RunApproval {
  id: string;
  skillId: string;
  capability: GrantCapability;
  summary: string;
  status: 'pending' | 'allowed' | 'denied';
  at: number;
  resolvedAt?: number;
  /** Requested scope when resolved (session or always). */
  scope?: 'session' | 'always';
}

export interface RunArtifact {
  path: string;
  /** Populated when the client archives the artifact into the asset library. */
  assetId?: string;
  assetName?: string;
  assetSizeBytes?: number;
  createdAt?: number;
}

export interface RunSearchSource {
  title: string;
  url: string;
  source?: string;
}

export interface RunRecord {
  id: string;
  /** Owning session id (chat session or project id). */
  sessionId: string;
  kind: 'chat' | 'project-task';
  taskId?: string;
  /** Turn anchor in chat sessions. */
  turnId?: string;
  attemptNo: number;
  status: RunStatus;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** Accumulated assistant text (final). */
  transcript: string;
  activities: RunActivity[];
  approvals: RunApproval[];
  artifacts: RunArtifact[];
  sources: RunSearchSource[];
  /** Bounded event log for replay/debug. */
  eventLog: AgentEvent[];
  /** Reason when cancelled. */
  cancelReason?: 'user' | 'timeout';
}

/* ------------------------------------------------------------------ *
 * Projects (项目对话 / 编排)
 * ------------------------------------------------------------------ */

export type ProjectStatus = 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ProjectTaskStatus = 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ProjectMode = 'waterfall' | 'parallel' | 'discussion' | 'dag';
export type PermissionTier = 'read-only' | 'default' | 'full';

export interface ProjectTask {
  id: string;
  title: string;
  objective: string;
  employeeId: string;
  skillIds: string[];
  dependsOn: string[];
  permissionTier: PermissionTier;
  status: ProjectTaskStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  runId?: string;
  error?: string;
}

export interface ProjectMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  employeeId?: string;
  taskId?: string;
  createdAt: number;
}

export interface ProjectRun {
  id: string;
  projectId: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  taskIds: string[];
  summary?: string;
  error?: string;
}

export interface Project {
  id: string;
  name: string;
  goal: string;
  status: ProjectStatus;
  mode: ProjectMode;
  workspacePath: string;
  tasks: ProjectTask[];
  messages: ProjectMessage[];
  createdAt: number;
  updatedAt: number;
  activeRunId?: string;
  summary?: string;
  /** Coordinator metadata supplied by the client at confirm time. */
  coordinator?: { provider: string; model: string };
  /** Latest task transcripts (kept out of Project to bound payload size). */
  /** Grants applied while tasks of this project run (advisory for assemblers). */
  grantsSession?: Record<string, GrantCapability[]>;
  grantsAlways?: Record<string, GrantCapability[]>;
}

export interface ProjectTaskTranscript {
  runId: string;
  assistantContent: string;
  activities: RunActivity[];
  approvals: RunApproval[];
  artifacts: RunArtifact[];
  sources: RunSearchSource[];
  status: RunStatus;
  error?: string;
}
