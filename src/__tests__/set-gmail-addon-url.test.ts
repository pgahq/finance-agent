import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.join(process.cwd(), 'scripts/set-gmail-addon-url.js');
const sandboxTemplate = path.join(process.cwd(), 'gmail-addon/deployment.sandbox.json');
const exampleUrl = 'https://abc123.execute-api.us-east-1.amazonaws.com/gmail-addon';

describe('set-gmail-addon-url', () => {
  it('writes the stack URL into homepage and contextual triggers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-addon-'));
    const file = path.join(dir, 'deployment.json');
    fs.copyFileSync(sandboxTemplate, file);

    execFileSync(process.execPath, [script, file, exampleUrl], { stdio: 'pipe' });

    const deployment = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      addOns: {
        common: { homepageTrigger: { runFunction: string } };
        gmail: { contextualTriggers: Array<{ onTriggerFunction: string }> };
      };
    };
    expect(deployment.addOns.common.homepageTrigger.runFunction).toBe(exampleUrl);
    expect(deployment.addOns.gmail.contextualTriggers[0].onTriggerFunction).toBe(exampleUrl);
    expect(deployment.addOns.common.homepageTrigger.runFunction).not.toContain('REPLACE_WITH_');
  });

  it('rejects a non-https URL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-addon-'));
    const file = path.join(dir, 'deployment.json');
    fs.copyFileSync(sandboxTemplate, file);

    expect(() => execFileSync(process.execPath, [script, file, 'http://example.com/gmail-addon'], { stdio: 'pipe' }))
      .toThrow(/https URL/);
  });
});
