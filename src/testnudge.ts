import type { Issue } from './schema';

const SOURCE_RX = /^(src|lib|app|packages\/[^/]+\/src)\//i;
const TEST_RX = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[jt]sx?$/i;
const NON_CODE_RX = /\.(md|mdx|txt|json|yml|yaml|toml|lock|svg|png|jpg|jpeg|gif|webp|ico|css|scss|sass|html)$/i;

export function checkMissingTests(touchedPaths: string[]): Issue | null {
  const sourceFiles = touchedPaths.filter(
    (p) => SOURCE_RX.test(p) && !TEST_RX.test(p) && !NON_CODE_RX.test(p)
  );
  const testFiles = touchedPaths.filter((p) => TEST_RX.test(p));
  if (sourceFiles.length === 0) return null;
  if (testFiles.length > 0) return null;
  return {
    severity: 'SUGGESTION',
    file: sourceFiles[0],
    line: 0,
    issue: `Source changed, tests did not — ${sourceFiles.length} source file(s), 0 test file(s).`,
    why: 'Untested changes are the most common source of regressions. Even one happy-path test catches refactors that break behavior.',
    fix: 'Add or update a test covering the new behavior. If the change is truly untestable (docs, config), ignore this.',
    confidence: 0.9,
  };
}
