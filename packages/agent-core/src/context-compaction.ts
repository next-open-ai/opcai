import { generateText, pruneMessages, type ModelMessage } from 'ai';
import type { LanguageModel } from 'ai';

/** Soft threshold (~10–12k tokens): prune reasoning + older tool traces. */
const SOFT_CHAR_LIMIT = 40_000;
/** Hard threshold after prune: prefer 提配 before summarizing. */
const HARD_CHAR_LIMIT = 56_000;
/** Boosted hard limit (提配): continue without summarizing until this ceiling. */
const HARD_BOOST_CHAR_LIMIT = 84_000;
/** Keep the newest N messages verbatim after summarization. */
const KEEP_RECENT_MESSAGES = 8;
/** Cap the prompt fed into the summarizer. */
const SUMMARY_SOURCE_CHARS = 48_000;
/** Cap the summary stored back into the conversation. */
const SUMMARY_MAX_CHARS = 3_500;

/** Shared prefix for ephemeral step compaction and durable session memory. */
export const SESSION_SUMMARY_PREFIX = '[OPCAI context summary]';
const SUMMARY_PREFIX = SESSION_SUMMARY_PREFIX;

/** Soft budget for durable session memory (summary + uncovered turns). */
export const SESSION_MEMORY_BUDGET_CHARS = 24_000;
/** Keep this many newest canonical messages verbatim after a session roll. */
export const SESSION_MEMORY_KEEP_RECENT = KEEP_RECENT_MESSAGES;
/** Cap stored session summary text. */
export const SESSION_MEMORY_SUMMARY_MAX_CHARS = SUMMARY_MAX_CHARS;

function estimateChars(messages: ModelMessage[]): number {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return messages.length * 2_000;
  }
}

function partText(part: unknown): string {
  if (!part || typeof part !== 'object') return '';
  const value = part as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  if (value.type === 'tool-call') return `[tool-call ${String(value.toolName || '')}]`;
  if (value.type === 'tool-result') {
    const output = value.output ?? value.result;
    const preview = typeof output === 'string' ? output : JSON.stringify(output ?? '');
    return `[tool-result ${String(value.toolName || '')}] ${preview.slice(0, 800)}`;
  }
  if (value.type === 'reasoning' && typeof value.text === 'string') return value.text.slice(0, 200);
  return '';
}

function messageToPlain(message: ModelMessage): string {
  const role = message.role;
  if (typeof message.content === 'string') return `${role}: ${message.content}`;
  if (!Array.isArray(message.content)) return `${role}:`;
  const body = message.content.map(partText).filter(Boolean).join('\n');
  return `${role}:\n${body}`;
}

/** Avoid cutting in the middle of an assistant→tool result sequence. */
function splitForSummary(messages: ModelMessage[], keepRecent: number) {
  let split = Math.max(0, messages.length - keepRecent);
  while (split > 0 && messages[split]?.role === 'tool') split -= 1;
  if (split <= 0 || split >= messages.length) return null;
  return {
    older: messages.slice(0, split),
    recent: messages.slice(split),
  };
}

function pruneAggressively(messages: ModelMessage[], keepToolWindow: 'before-last-2-messages' | 'before-last-message') {
  return pruneMessages({
    messages,
    reasoning: 'all',
    toolCalls: keepToolWindow,
    emptyMessages: 'remove',
  });
}

const SUMMARY_SYSTEM = [
  'You compress prior agent conversation into a continuity brief for the same agent.',
  'Preserve: user goals, constraints, decisions, file paths created/edited, failed attempts, and next unfinished work.',
  'Omit: raw CSS/HTML dumps, repeated tool JSON, reasoning traces, and chit-chat.',
  'Write in the same language as the user content. Max ~400 words. No markdown fences.',
].join(' ');

async function summarizeDigest(input: {
  digest: string;
  model: LanguageModel;
  providerOptions?: Record<string, unknown>;
  minChars?: number;
}): Promise<string | null> {
  const digest = input.digest.trim().slice(0, SUMMARY_SOURCE_CHARS);
  if (digest.length < (input.minChars ?? 400)) return null;
  try {
    const { text } = await generateText({
      model: input.model,
      system: SUMMARY_SYSTEM,
      prompt: digest,
      maxOutputTokens: 900,
      ...(input.providerOptions ? { providerOptions: input.providerOptions as never } : {}),
    });
    const summary = text.trim().slice(0, SUMMARY_MAX_CHARS);
    return summary || null;
  } catch {
    return null;
  }
}

async function summarizeOlderTurns(input: {
  older: ModelMessage[];
  model: LanguageModel;
  providerOptions?: Record<string, unknown>;
}): Promise<string | null> {
  const digest = input.older.map(messageToPlain).join('\n\n---\n\n');
  return summarizeDigest({
    digest,
    model: input.model,
    providerOptions: input.providerOptions,
  });
}

/**
 * Summarize plain user/assistant turns for durable session rolling memory.
 * Optionally folds a previous summary into the new brief.
 */
export async function summarizePlainTurns(input: {
  previousSummary?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: LanguageModel;
  providerOptions?: Record<string, unknown>;
}): Promise<string | null> {
  const body = input.turns
    .map((turn) => `${turn.role}: ${turn.content}`)
    .join('\n\n---\n\n');
  const digest = [
    input.previousSummary?.trim()
      ? `Previous session summary:\n${input.previousSummary.trim()}`
      : '',
    body,
  ]
    .filter(Boolean)
    .join('\n\n====\n\n');
  return summarizeDigest({
    digest,
    model: input.model,
    providerOptions: input.providerOptions,
    minChars: 120,
  });
}

/**
 * Context compaction for streamText `prepareStep`:
 * 1) When soft limit exceeded → drop reasoning + older tool-call/result pairs.
 * 2) When still over hard limit → LLM-summarize older turns, keep recent messages.
 */
export async function compactMessagesForStep(input: {
  messages: ModelMessage[];
  model: LanguageModel;
  providerOptions?: Record<string, unknown>;
}): Promise<{ messages: ModelMessage[]; didPrune: boolean; didSummarize: boolean }> {
  let messages = input.messages;
  let didPrune = false;
  let didSummarize = false;

  if (estimateChars(messages) < SOFT_CHAR_LIMIT) {
    return { messages, didPrune, didSummarize };
  }

  messages = pruneAggressively(messages, 'before-last-2-messages');
  didPrune = true;

  if (estimateChars(messages) < HARD_CHAR_LIMIT) {
    return { messages, didPrune, didSummarize };
  }

  messages = pruneAggressively(messages, 'before-last-message');

  // 提配：放宽硬限，继续执行，不因超预算中断；仅在提配后仍超限才摘要。
  if (estimateChars(messages) < HARD_BOOST_CHAR_LIMIT) {
    return { messages, didPrune, didSummarize };
  }

  const parts = splitForSummary(messages, KEEP_RECENT_MESSAGES);
  if (!parts) return { messages, didPrune, didSummarize };

  const summary = await summarizeOlderTurns({
    older: parts.older,
    model: input.model,
    providerOptions: input.providerOptions,
  });
  if (!summary) return { messages, didPrune, didSummarize };

  didSummarize = true;
  messages = [
    {
      role: 'user',
      content: `${SUMMARY_PREFIX}\n${summary}\n\nContinue from this summary and the recent messages below. Do not re-read the entire history.`,
    },
    {
      role: 'assistant',
      content: 'Understood. I will use the summary as prior context and continue with the recent turns.',
    },
    ...parts.recent,
  ];

  // Drop any leading orphan tool messages that survived the split.
  while (messages.length && messages[0]?.role === 'tool') messages = messages.slice(1);

  return { messages, didPrune, didSummarize };
}

/** Build the user/assistant pair used to inject a durable or ephemeral summary. */
export function sessionSummaryMessagePair(summary: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const text = summary.trim();
  if (!text) return [];
  return [
    {
      role: 'user',
      content: `${SESSION_SUMMARY_PREFIX}\n${text}\n\nContinue from this summary and the recent messages below. Do not re-read the entire history.`,
    },
    {
      role: 'assistant',
      content: 'Understood. I will use the summary as prior context and continue with the recent turns.',
    },
  ];
}
