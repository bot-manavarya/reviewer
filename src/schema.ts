import { z } from 'zod';

export const IssueSchema = z.object({
  severity: z.enum(['CRITICAL', 'WARNING', 'SUGGESTION']),
  file: z.string(),
  line: z.coerce.number().int().nonnegative().default(0),
  issue: z.string(),
  why: z.string().default(''),
  fix: z.string().default(''),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
});

export const ReviewSchema = z.object({
  summary: z
    .object({
      files_changed: z.coerce.number().int().nonnegative().default(0),
      lines_added: z.coerce.number().int().nonnegative().default(0),
      lines_removed: z.coerce.number().int().nonnegative().default(0),
      main_concern: z.string().default(''),
    })
    .default({
      files_changed: 0,
      lines_added: 0,
      lines_removed: 0,
      main_concern: '',
    }),
  issues: z.array(IssueSchema).default([]),
  notes: z.array(z.string()).default([]),
});

export type Issue = z.infer<typeof IssueSchema>;
export type Review = z.infer<typeof ReviewSchema>;

export function parseReview(raw: string): Review {
  const trimmed = extractJson(raw);
  const data = JSON.parse(trimmed);
  return ReviewSchema.parse(data);
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Model output did not contain a JSON object');
  }
  return candidate.slice(start, end + 1);
}
