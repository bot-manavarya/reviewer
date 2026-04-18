/**
 * Local dev CLI: run a review against a live PR without running as a GH Action.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx GEMINI_API_KEY=... ts-node src/cli.ts <owner> <repo> <prNumber>
 *
 * Env:
 *   PROVIDER       gemini | ollama          (default: gemini)
 *   GEMINI_API_KEY required when PROVIDER=gemini
 *   MODEL          override default model
 *   OLLAMA_URL     only for PROVIDER=ollama (default: http://localhost:11434)
 *   DRY_RUN        true|false (default: true — prints instead of posting)
 */
import * as github from '@actions/github';
import { fetchPrContext, upsertReviewComment } from './github';
import * as ollama from './ollama';
import * as gemini from './gemini';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt';
import { parseReview } from './schema';
import { finalize } from './scoring';
import { renderMarkdown } from './markdown';

async function main() {
  const [owner, repo, prStr] = process.argv.slice(2);
  if (!owner || !repo || !prStr) {
    console.error('Usage: ts-node src/cli.ts <owner> <repo> <prNumber>');
    process.exit(1);
  }
  const prNumber = Number(prStr);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var is required');

  const provider = (process.env.PROVIDER || 'gemini').toLowerCase();
  const model =
    process.env.MODEL ||
    (provider === 'gemini' ? 'gemini-2.0-flash' : 'qwen2.5-coder:7b');
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const geminiKey = process.env.GEMINI_API_KEY || '';
  const dryRun = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

  if (provider === 'gemini' && !geminiKey) {
    throw new Error('GEMINI_API_KEY env var is required when PROVIDER=gemini');
  }

  const octo = github.getOctokit(token);
  const { data: prData } = await octo.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  (github.context as unknown as { payload: unknown }).payload = {
    pull_request: prData,
  };
  (github.context as unknown as { repo: { owner: string; repo: string } }).repo = {
    owner,
    repo,
  };

  if (provider === 'ollama') {
    await ollama.ensureModel({ baseUrl: ollamaUrl, model });
  }
  const ctx = await fetchPrContext(octo, 20000, 120000);

  const user = buildUserPrompt({
    prNumber: ctx.prNumber,
    prTitle: ctx.prTitle,
    prBody: ctx.prBody,
    filesChanged: ctx.filesChanged,
    linesAdded: ctx.linesAdded,
    linesRemoved: ctx.linesRemoved,
    diff: ctx.diff,
    files: ctx.files,
  });

  const raw =
    provider === 'gemini'
      ? await gemini.chatJson(
          { apiKey: geminiKey, model, temperature: 0.1 },
          SYSTEM_PROMPT,
          user
        )
      : await ollama.chatJson(
          { baseUrl: ollamaUrl, model, temperature: 0.1 },
          SYSTEM_PROMPT,
          user
        );

  const parsed = parseReview(raw);
  parsed.summary.files_changed = ctx.filesChanged;
  parsed.summary.lines_added = ctx.linesAdded;
  parsed.summary.lines_removed = ctx.linesRemoved;

  const { review, risk, quality } = finalize(
    parsed,
    {
      filesChanged: ctx.filesChanged,
      linesAdded: ctx.linesAdded,
      linesRemoved: ctx.linesRemoved,
      touchedPaths: ctx.touchedPaths,
      hasTestChanges: ctx.hasTestChanges,
    },
    0.65
  );

  const md = renderMarkdown(ctx.prNumber, review, risk, quality, model);
  console.log(md);

  if (!dryRun) {
    await upsertReviewComment(octo, owner, repo, prNumber, md);
    console.log(`\nPosted on ${owner}/${repo}#${prNumber}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
