import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('SAM template', () => {
  const globals = readFileSync(join(process.cwd(), 'template.yml'), 'utf8').split('\nResources:')[0];

  it('disables Lambda async retries for all functions', () => {
    expect(globals).toContain('EventInvokeConfig:');
    expect(globals).toMatch(/MaximumRetryAttempts:\s*0\b/);
  });
});
