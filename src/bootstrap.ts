/**
 * Bootstrap workflow: run from the reviewer repo.
 *
 * Accepts any pending collaborator invites for bot-manavarya, then for every
 * repo where the bot is a collaborator, ensures:
 *   - the manavarya-bot.yml workflow exists
 *   - the GEMINI_API_KEY secret exists
 *   - the MANAVARYA_BOT_TOKEN secret exists
 *
 * Environment:
 *   BOT_PAT          the bot's PAT (Contents:W, Secrets:W, Workflows:W, Metadata:R)
 *   GEMINI_API_KEY   the Google AI Studio API key
 *   DRY_RUN          "true" to print planned actions without writing
 */
import { Octokit } from '@octokit/rest';
import sodium from 'libsodium-wrappers';

const WORKFLOW_PATH = '.github/workflows/manavarya-bot.yml';

const WORKFLOW_CONTENT = `# Managed by bot-manavarya/reviewer — edits will be overwritten.
name: manavarya-bot review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    if: \${{ github.event.pull_request.draft == false }}
    uses: bot-manavarya/reviewer/.github/workflows/review.yml@main
    with:
      provider: 'gemini'
      model: 'gemini-2.0-flash'
    secrets:
      bot-token: \${{ secrets.MANAVARYA_BOT_TOKEN }}
      gemini-api-key: \${{ secrets.GEMINI_API_KEY }}
`;

const SELF_OWNER = 'bot-manavarya';
const DRY = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

async function encryptSecret(publicKey: string, value: string): Promise<string> {
  await sodium.ready;
  const binkey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const binsec = sodium.from_string(value);
  const enc = sodium.crypto_box_seal(binsec, binkey);
  return sodium.to_base64(enc, sodium.base64_variants.ORIGINAL);
}

async function acceptInvites(octo: Octokit): Promise<void> {
  const invites = await octo.paginate(
    octo.rest.repos.listInvitationsForAuthenticatedUser,
    { per_page: 100 }
  );
  for (const inv of invites) {
    const repoFull = inv.repository.full_name;
    console.log(`[invite] accepting ${repoFull}`);
    if (DRY) continue;
    await octo.rest.repos.acceptInvitationForAuthenticatedUser({
      invitation_id: inv.id,
    });
  }
  if (invites.length === 0) console.log('[invite] no pending invitations');
}

async function listCollabRepos(octo: Octokit) {
  const repos = await octo.paginate(octo.rest.repos.listForAuthenticatedUser, {
    affiliation: 'collaborator',
    per_page: 100,
  });
  return repos.filter((r) => r.owner.login.toLowerCase() !== SELF_OWNER.toLowerCase());
}

async function ensureWorkflow(
  octo: Octokit,
  owner: string,
  repo: string
): Promise<void> {
  let existingSha: string | undefined;
  let existingContent: string | undefined;
  try {
    const res = await octo.rest.repos.getContent({
      owner,
      repo,
      path: WORKFLOW_PATH,
    });
    const data = res.data as {
      type?: string;
      sha?: string;
      content?: string;
      encoding?: string;
    };
    if (data.type === 'file') {
      existingSha = data.sha;
      if (data.content && data.encoding === 'base64') {
        existingContent = Buffer.from(data.content, 'base64').toString('utf8');
      }
    }
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status !== 404) throw e;
  }

  if (existingContent === WORKFLOW_CONTENT) {
    console.log(`  workflow already up-to-date`);
    return;
  }

  console.log(
    `  ${existingSha ? 'updating' : 'creating'} ${WORKFLOW_PATH}`
  );
  if (DRY) return;

  await octo.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: WORKFLOW_PATH,
    message: existingSha
      ? 'chore(manavarya-bot): sync reviewer workflow'
      : 'chore(manavarya-bot): add reviewer workflow',
    content: Buffer.from(WORKFLOW_CONTENT).toString('base64'),
    sha: existingSha,
    committer: {
      name: 'bot-manavarya',
      email: 'bot-manavarya@users.noreply.github.com',
    },
    author: {
      name: 'bot-manavarya',
      email: 'bot-manavarya@users.noreply.github.com',
    },
  });
}

async function ensureSecret(
  octo: Octokit,
  owner: string,
  repo: string,
  name: string,
  value: string,
  cache: Map<string, { key: string; key_id: string }>
): Promise<void> {
  // Skip if the secret already exists (we can't read the value to compare; we
  // assume the user stored the right one the first time, or rotated it
  // themselves via the bootstrap workflow secrets).
  try {
    await octo.rest.actions.getRepoSecret({ owner, repo, secret_name: name });
    console.log(`  secret ${name} exists`);
    return;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status !== 404) throw e;
  }

  const cacheKey = `${owner}/${repo}`;
  let pub = cache.get(cacheKey);
  if (!pub) {
    const { data } = await octo.rest.actions.getRepoPublicKey({ owner, repo });
    pub = { key: data.key, key_id: data.key_id };
    cache.set(cacheKey, pub);
  }

  console.log(`  creating secret ${name}`);
  if (DRY) return;

  const encrypted_value = await encryptSecret(pub.key, value);
  await octo.rest.actions.createOrUpdateRepoSecret({
    owner,
    repo,
    secret_name: name,
    encrypted_value,
    key_id: pub.key_id,
  });
}

async function runOnce(
  octo: Octokit,
  botPat: string,
  geminiKey: string
): Promise<{ ok: number; failed: string[] }> {
  await acceptInvites(octo);

  const repos = await listCollabRepos(octo);
  console.log(`Found ${repos.length} collaborator repo(s).`);

  const pubKeyCache = new Map<string, { key: string; key_id: string }>();
  const failed: string[] = [];

  for (const r of repos) {
    const full = `${r.owner.login}/${r.name}`;
    console.log(`--> ${full}`);
    try {
      await ensureWorkflow(octo, r.owner.login, r.name);
      await ensureSecret(
        octo,
        r.owner.login,
        r.name,
        'MANAVARYA_BOT_TOKEN',
        botPat,
        pubKeyCache
      );
      await ensureSecret(
        octo,
        r.owner.login,
        r.name,
        'GEMINI_API_KEY',
        geminiKey,
        pubKeyCache
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  FAILED: ${msg}`);
      failed.push(`${full}: ${msg}`);
    }
  }

  return { ok: repos.length - failed.length, failed };
}

async function main() {
  const botPat = required('BOT_PAT');
  const geminiKey = required('GEMINI_API_KEY');

  const octo = new Octokit({ auth: botPat });

  const me = await octo.rest.users.getAuthenticated();
  console.log(`Authenticated as ${me.data.login}${DRY ? ' (dry-run)' : ''}`);

  const pollSeconds = Number(process.env.POLL_SECONDS || '0');
  const maxRuntimeSeconds = Number(process.env.MAX_RUNTIME_SECONDS || '280');

  if (pollSeconds <= 0) {
    const { ok, failed } = await runOnce(octo, botPat, geminiKey);
    console.log(`\n--- summary ---`);
    console.log(`OK: ${ok}  Failed: ${failed.length}`);
    if (failed.length) {
      for (const f of failed) console.log(`  - ${f}`);
      process.exit(1);
    }
    return;
  }

  const deadline = Date.now() + maxRuntimeSeconds * 1000;
  let iter = 0;
  console.log(
    `Polling every ${pollSeconds}s for up to ${maxRuntimeSeconds}s...`
  );
  while (Date.now() < deadline) {
    iter++;
    console.log(`\n[iter ${iter}] ${new Date().toISOString()}`);
    try {
      await runOnce(octo, botPat, geminiKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`iter ${iter} failed: ${msg}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const sleepMs = Math.min(pollSeconds * 1000, remaining);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  console.log(`\nDone after ${iter} iterations.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
