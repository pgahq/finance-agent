#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.addons.execute',
  'https://www.googleapis.com/auth/gmail.addons.current.message.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];
const LOGO_URL = 'https://www.gstatic.com/images/branding/product/2x/googleg_48dp.png';
const PRIMARY_COLOR = '#00205C';

export function gmailAddonDeploymentId(environment) {
  if (environment === 'production') return 'finance-agent-gmail';
  if (environment === 'sandbox') return 'finance-agent-gmail-sandbox';
  throw new Error('ADDON_ENVIRONMENT must be sandbox or production');
}

export function gmailAddonDisplayName(environment) {
  if (environment === 'production') return 'Workday supplier invoice';
  if (environment === 'sandbox') return 'Workday supplier invoice (sandbox)';
  throw new Error('ADDON_ENVIRONMENT must be sandbox or production');
}

export function buildGmailAddonDeployment({ environment, url }) {
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) {
    throw new Error('Gmail add-on URL must be an https URL');
  }
  const name = gmailAddonDisplayName(environment);
  return {
    oauthScopes: OAUTH_SCOPES,
    addOns: {
      common: {
        name,
        logoUrl: LOGO_URL,
        layoutProperties: {
          primaryColor: PRIMARY_COLOR,
        },
        homepageTrigger: {
          runFunction: url,
        },
      },
      gmail: {
        contextualTriggers: [
          {
            unconditional: {},
            onTriggerFunction: url,
          },
        ],
      },
    },
  };
}

function parseArgs(argv) {
  const args = { environment: undefined, url: undefined, out: undefined, printId: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--print-id') {
      args.printId = true;
    } else if (flag === '--environment' || flag === '--url' || flag === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === '--environment') args.environment = value;
      if (flag === '--url') args.url = value;
      if (flag === '--out') args.out = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const environment = args.environment ?? process.env.ADDON_ENVIRONMENT;
    if (args.printId) {
      process.stdout.write(`${gmailAddonDeploymentId(environment)}\n`);
      process.exit(0);
    }
    const url = args.url ?? process.env.GMAIL_ADDON_URL;
    const deployment = buildGmailAddonDeployment({ environment, url });
    const json = `${JSON.stringify(deployment, null, 2)}\n`;
    if (args.out) {
      fs.writeFileSync(args.out, json);
    } else {
      process.stdout.write(json);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
