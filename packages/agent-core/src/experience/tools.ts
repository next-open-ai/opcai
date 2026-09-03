import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { ModelConfig } from '@opcai/contracts';
import { loadExperience, saveExperience } from './service.js';
import { EXPERIENCE_LIMITS, formatExperienceCard } from './types.js';

/**
 * Agent-scoped experience tools. Independent from knowledge-base tools.
 * agentId is closed over from the run profile (cannot be spoofed by the model).
 */
export function createExperienceTools(input: {
  agentId: string;
  model?: ModelConfig;
  enabled?: boolean;
  minScore?: number;
}): Record<string, Tool> {
  const agentId = String(input.agentId || '').trim();
  if (!agentId || input.enabled === false) return {};

  const minScore = input.minScore ?? EXPERIENCE_LIMITS.minScore;

  return {
    save_experience: tool({
      description:
        'Save a short reusable experience for THIS agent after a meaningful complex task '
        + '(successful approach, hard-won pitfall, or durable project convention). '
        + 'Keep fields concise. Do not dump raw chat logs. Skip trivial one-shot answers.',
      inputSchema: z.object({
        title: z.string().min(2).max(EXPERIENCE_LIMITS.title),
        situation: z.string().min(8).max(EXPERIENCE_LIMITS.situation).describe('When this experience applies.'),
        action: z.string().min(8).max(EXPERIENCE_LIMITS.action).describe('What worked / recommended steps.'),
        pitfall: z.string().max(EXPERIENCE_LIMITS.pitfall).optional().describe('What to avoid.'),
        whenNot: z.string().max(EXPERIENCE_LIMITS.whenNot).optional().describe('When NOT to apply this.'),
        tags: z.array(z.string().max(EXPERIENCE_LIMITS.tagLen)).max(EXPERIENCE_LIMITS.tags).optional(),
      }),
      execute: async ({ title, situation, action, pitfall, whenNot, tags }) => {
        try {
          const saved = await saveExperience({
            agentId,
            title,
            situation,
            action,
            pitfall,
            whenNot,
            tags,
            model: input.model,
          });
          return {
            ok: true,
            id: saved.id,
            merged: saved.merged,
            backend: saved.backend,
            title: saved.title,
          };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Failed to save experience.',
          };
        }
      },
    }),

    load_experience: tool({
      description:
        'Load high-confidence past experiences for THIS agent by semantic similarity to a query. '
        + `Only returns items with score >= ${minScore}; otherwise empty. `
        + 'Use when starting or pivoting a complex task that may match prior work.',
      inputSchema: z.object({
        query: z.string().min(2).max(400),
        topK: z.number().int().min(1).max(3).optional(),
      }),
      execute: async ({ query, topK }) => {
        try {
          const loaded = await loadExperience({
            agentId,
            query,
            topK,
            minScore,
            model: input.model,
          });
          return {
            ok: true,
            count: loaded.count,
            minScore: loaded.minScore,
            backend: loaded.backend,
            results: loaded.results.map((item) => ({
              id: item.id,
              score: item.score,
              card: formatExperienceCard(item),
              tags: item.tags,
            })),
          };
        } catch (error) {
          return {
            ok: false,
            count: 0,
            results: [],
            message: error instanceof Error ? error.message : 'Failed to load experience.',
          };
        }
      },
    }),
  };
}
