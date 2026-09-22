import { buildWorkdayObjectDeeplink } from '../lib/workday_deeplink.js';

describe('buildWorkdayObjectDeeplink', () => {
  const originalUiBaseUrl = process.env.WORKDAY_UI_BASE_URL;
  const originalTenant = process.env.WORKDAY_TENANT;

  afterEach(() => {
    if (originalUiBaseUrl === undefined) delete process.env.WORKDAY_UI_BASE_URL;
    else process.env.WORKDAY_UI_BASE_URL = originalUiBaseUrl;
    if (originalTenant === undefined) delete process.env.WORKDAY_TENANT;
    else process.env.WORKDAY_TENANT = originalTenant;
  });

  it('builds an implementation Workday object URL', () => {
    expect(buildWorkdayObjectDeeplink(
      'a1b2c3d4e5f678901234567890abcdef',
      'https://impl.workday.com',
      'pgahq',
    )).toBe('https://impl.workday.com/pgahq/d/inst/deeplink/a1b2c3d4e5f678901234567890abcdef.htmld');
  });

  it('builds a production Workday object URL', () => {
    expect(buildWorkdayObjectDeeplink(
      'a1b2c3d4e5f678901234567890abcdef',
      'https://www.myworkday.com',
      'pgahq',
    )).toBe('https://www.myworkday.com/pgahq/d/inst/deeplink/a1b2c3d4e5f678901234567890abcdef.htmld');
  });

  it('reads WORKDAY_UI_BASE_URL and WORKDAY_TENANT from the environment', () => {
    process.env.WORKDAY_UI_BASE_URL = 'https://impl.workday.com/';
    process.env.WORKDAY_TENANT = 'pgahq';
    expect(buildWorkdayObjectDeeplink('new-invoice-wid')).toBe(
      'https://impl.workday.com/pgahq/d/inst/deeplink/new-invoice-wid.htmld'
    );
  });

  it('returns undefined when the WID, UI base URL, or tenant is missing', () => {
    delete process.env.WORKDAY_UI_BASE_URL;
    delete process.env.WORKDAY_TENANT;
    expect(buildWorkdayObjectDeeplink('wid', undefined, 'pgahq')).toBeUndefined();
    expect(buildWorkdayObjectDeeplink('wid', 'https://impl.workday.com')).toBeUndefined();
    expect(buildWorkdayObjectDeeplink('  ', 'https://impl.workday.com', 'pgahq')).toBeUndefined();
    expect(buildWorkdayObjectDeeplink(undefined, 'https://impl.workday.com', 'pgahq')).toBeUndefined();
  });
});
