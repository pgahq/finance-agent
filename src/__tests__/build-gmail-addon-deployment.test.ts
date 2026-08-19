import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.join(process.cwd(), 'scripts/build-gmail-addon-deployment.js');
const exampleUrl = 'https://abc123.execute-api.us-east-1.amazonaws.com/gmail-addon';

function run(args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }).trim();
}

describe('build-gmail-addon-deployment', () => {
  it('prints distinct gcloud deployment ids per environment', () => {
    expect(run(['--environment', 'sandbox', '--print-id'])).toBe('finance-agent-gmail-sandbox');
    expect(run(['--environment', 'production', '--print-id'])).toBe('finance-agent-gmail');
  });

  it('builds sandbox JSON with the stack URL and sandbox display name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-addon-'));
    const file = path.join(dir, 'deployment.json');
    run(['--environment', 'sandbox', '--url', exampleUrl, '--out', file]);

    const deployment = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      addOns: {
        common: { name: string; homepageTrigger: { runFunction: string } };
        gmail: { contextualTriggers: Array<{ onTriggerFunction: string }> };
      };
    };
    expect(deployment.addOns.common.name).toBe('Workday supplier invoice (sandbox)');
    expect(deployment.addOns.common.homepageTrigger.runFunction).toBe(exampleUrl);
    expect(deployment.addOns.gmail.contextualTriggers[0].onTriggerFunction).toBe(exampleUrl);
  });

  it('builds production JSON with the production display name', () => {
    const json = JSON.parse(run(['--environment', 'production', '--url', exampleUrl])) as {
      addOns: { common: { name: string } };
    };
    expect(json.addOns.common.name).toBe('Workday supplier invoice');
  });

  it('rejects a non-https URL', () => {
    expect(() => run(['--environment', 'sandbox', '--url', 'http://example.com/gmail-addon']))
      .toThrow(/https URL/);
  });
});
