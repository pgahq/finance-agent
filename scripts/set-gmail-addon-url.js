#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function setGmailAddonEndpointUrl(deployment, url) {
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) {
    throw new Error('Gmail add-on URL must be an https URL');
  }
  const homepageTrigger = deployment?.addOns?.common?.homepageTrigger;
  const contextualTrigger = deployment?.addOns?.gmail?.contextualTriggers?.[0];
  if (!homepageTrigger || !contextualTrigger) {
    throw new Error('deployment JSON is missing homepageTrigger or gmail.contextualTriggers[0]');
  }
  homepageTrigger.runFunction = url;
  contextualTrigger.onTriggerFunction = url;
  return deployment;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const [file, url] = process.argv.slice(2);
  if (!file || !url) {
    console.error('Usage: node scripts/set-gmail-addon-url.js <deployment.json> <https-url>');
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(file, 'utf8'));
  setGmailAddonEndpointUrl(deployment, url);
  fs.writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
}
