/**
 * Local dev CLI: hits GitHub + your local Ollama without running inside an Action.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx ts-node src/cli.ts <owner> <repo> <prNumber>
 */
import * as github from '@actions/github';
import { fetchPrContext, upsertReviewComment } from './github';
import { chatJson, ensureModel } from './ollama';
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

  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
  const dryRun = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

  // Inject a minimal pull_request context so fetchPrContext works.
  (github.context as unknown as { payload: unknown }).payload = {
    pull_request: await (async () => {
      const octo = github.getOctokit(token);
      const { data } = await octo.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return data;
    })(),
  };
  (github.context as unknown as { repo: { owner: string; repo: string } }).repo = {
    owner,
    repo,
  };

  const octokit = github.getOctokit(token);
  await ensureModel({ baseUrl: ollamaUrl, model });
  const ctx = await fetchPrContext(octokit, 20000, 120000);

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

  const raw = await chatJson(
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
    await upsertReviewComment(octokit, owner, repo, prNumber, md);
    console.log(`\nPosted on ${owner}/${repo}#${prNumber}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
