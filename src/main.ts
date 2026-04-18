import * as core from '@actions/core';
import * as github from '@actions/github';
import { fetchPrContext, upsertReviewComment } from './github';
import * as ollama from './ollama';
import * as gemini from './gemini';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt';
import { parseReview } from './schema';
import { finalize } from './scoring';
import { renderMarkdown } from './markdown';
import { renderFailureMarkdown } from './markdown';

type Provider = 'gemini' | 'ollama';

interface PrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

async function tryPostFailure(
  token: string,
  pr: PrRef | null,
  stage: string,
  err: unknown,
  model: string,
  provider: Provider
): Promise<void> {
  if (!pr) return;
  try {
    const octo = github.getOctokit(token);
    const msg = err instanceof Error ? err.message : String(err);
    const md = renderFailureMarkdown(pr.prNumber, stage, msg, model, provider);
    await upsertReviewComment(octo, pr.owner, pr.repo, pr.prNumber, md);
  } catch (postErr) {
    core.warning(
      `Could not post failure comment: ${
        postErr instanceof Error ? postErr.message : String(postErr)
      }`
    );
  }
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  const provider = (
    (core.getInput('provider') || 'gemini').toLowerCase()
  ) as Provider;
  const modelInput = core.getInput('model');
  const ollamaUrl = core.getInput('ollama-url') || 'http://localhost:11434';
  const geminiKey = core.getInput('gemini-api-key');
  const maxFileBytes = Number(core.getInput('max-file-bytes') || '20000');
  const maxTotalBytes = Number(core.getInput('max-total-bytes') || '120000');
  const minConfidence = Number(core.getInput('min-confidence') || '0.65');
  const dryRun = (core.getInput('dry-run') || 'false').toLowerCase() === 'true';

  const model =
    modelInput ||
    (provider === 'gemini' ? 'gemini-1.5-flash' : 'qwen2.5-coder:7b');

  let pr: PrRef | null = null;

  try {
    if (provider !== 'gemini' && provider !== 'ollama') {
      throw new Error(
        `Unknown provider "${provider}". Must be "gemini" or "ollama".`
      );
    }
    if (provider === 'gemini' && !geminiKey) {
      throw new Error(
        'provider=gemini requires input "gemini-api-key" (store the key in a repo secret).'
      );
    }

    const octokit = github.getOctokit(token);

    core.info(`Provider: ${provider} · Model: ${model}`);
    if (provider === 'ollama') {
      await ollama.ensureModel({ baseUrl: ollamaUrl, model });
    }

    core.info('Fetching PR context…');
    const ctx = await fetchPrContext(octokit, maxFileBytes, maxTotalBytes);
    pr = { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.prNumber };
    core.info(
      `PR #${ctx.prNumber}: ${ctx.filesChanged} files, +${ctx.linesAdded}/-${ctx.linesRemoved}, ${ctx.files.length} files loaded for context.`
    );

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

    core.info(`Calling ${provider}…`);
    let raw: string;
    try {
      raw =
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
    } catch (err) {
      await tryPostFailure(token, pr, 'LLM call', err, model, provider);
      throw err;
    }

    let parsed;
    try {
      parsed = parseReview(raw);
    } catch (err) {
      await tryPostFailure(token, pr, 'Parse model output', err, model, provider);
      throw err;
    }
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
      minConfidence
    );

    const md = renderMarkdown(ctx.prNumber, review, risk, quality, model);

    core.setOutput('risk-score', String(risk));
    core.setOutput('quality-score', String(quality));
    core.setOutput('issue-count', String(review.issues.length));

    if (dryRun) {
      core.info('Dry run — not posting comment.');
      core.info(md);
      return;
    }

    await upsertReviewComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, md);
    core.info(`Posted review on PR #${ctx.prNumber}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (pr) {
      await tryPostFailure(token, pr, 'Reviewer', err, model, provider);
    }
    core.setFailed(msg);
  }
}

run();
