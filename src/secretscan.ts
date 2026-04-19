import type { Issue } from './schema';

interface SecretPattern {
  name: string;
  rx: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { name: 'AWS Access Key', rx: /AKIA[0-9A-Z]{16}/g },
  { name: 'AWS Secret Key', rx: /aws_secret_access_key\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]/gi },
  { name: 'GitHub Token (classic)', rx: /gh[ps]_[A-Za-z0-9]{36}/g },
  { name: 'GitHub Token (fine-grained)', rx: /github_pat_[A-Za-z0-9_]{22,255}/g },
  { name: 'Google API Key', rx: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: 'OpenAI API Key', rx: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'Anthropic API Key', rx: /sk-ant-api\d{2}-[A-Za-z0-9_-]{90,}/g },
  { name: 'xAI API Key', rx: /xai-[A-Za-z0-9]{80,}/g },
  { name: 'Slack Token', rx: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Stripe Live Key', rx: /sk_live_[A-Za-z0-9]{24,}/g },
  { name: 'Stripe Publishable Live', rx: /pk_live_[A-Za-z0-9]{24,}/g },
  { name: 'Private RSA Key', rx: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g },
  { name: 'Generic high-entropy env assignment', rx: /(?:password|secret|token|apikey|api_key)\s*[:=]\s*['"][A-Za-z0-9+/=_\-]{24,}['"]/gi },
];

interface FileToScan {
  path: string;
  content: string;
}

export function scanFilesForSecrets(files: FileToScan[]): Issue[] {
  const findings: Issue[] = [];
  for (const f of files) {
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 500) continue; // skip minified
      if (looksLikeTestOrExample(line)) continue;
      for (const p of PATTERNS) {
        p.rx.lastIndex = 0;
        if (p.rx.test(line)) {
          findings.push({
            severity: 'CRITICAL',
            file: f.path,
            line: i + 1,
            issue: `Possible leaked secret: ${p.name}`,
            why: 'Committing secrets to git exposes them to every past/future clone, CI log, and fork. Even if rewritten, the value must be considered compromised.',
            fix: `Rotate the secret immediately. Remove from the file, store in a secret manager or repo secret, reference via env var.`,
            confidence: 0.95,
          });
          break; // one finding per line
        }
      }
    }
  }
  return findings;
}

function looksLikeTestOrExample(line: string): boolean {
  const l = line.toLowerCase();
  return (
    l.includes('example') ||
    l.includes('dummy') ||
    l.includes('xxxxxx') ||
    l.includes('placeholder') ||
    l.includes('your_key_here') ||
    l.includes('your-key-here') ||
    l.includes('redacted')
  );
}
