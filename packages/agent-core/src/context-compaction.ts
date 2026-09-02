import { generateText, pruneMessages, type ModelMessage } from 'ai';
import type { LanguageModel } from 'ai';

/** Soft threshold (~10–12k tokens): prune reasoning + older tool traces. */
const SOFT_CHAR_LIMIT = 40_000;
/** Hard threshold after prune: summarize older turns with a short LLM call. */
const HARD_CHAR_LIMIT = 56_000;
/** Keep the newest N messages verbatim after summarization. */
const KEEP_RECENT_MESSAGES = 8;
/** Cap the prompt fed into the summarizer. */
const SUMMARY_SOURCE_CHARS = 48_000;
/** Cap the summary stored back into the conversation. */
const SUMMARY_MAX_CHARS = 3_500;

const SUMMARY_PREFIX = '[OPCAI context summary]';

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

async function summarizeOlderTurns(input: {
  older: ModelMessage[];
  model: LanguageModel;
  providerOptions?: Record<string, unknown>;
}): Promise<string | null> {
  const digest = input.older
    .map(messageToPlain)
    .join('\n\n---\n\n')
    .slice(0, SUMMARY_SOURCE_CHARS);
  if (digest.trim().length < 400) return null;
  try {
    const { text } = await generateText({
      model: input.model,
      system: [
        'You compress prior agent conversation into a continuity brief for the same agent.',
        'Preserve: user goals, constraints, decisions, file paths created/edited, failed attempts, and next unfinished work.',
        'Omit: raw CSS/HTML dumps, repeated tool JSON, reasoning traces, and chit-chat.',
        'Write in the same language as the user content. Max ~400 words. No markdown fences.',
      ].join(' '),
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

  if (estimateChars(messages) < HARD_CHAR_LIMIT) {
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
