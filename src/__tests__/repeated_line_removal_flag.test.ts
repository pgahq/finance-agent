import { repeatedLineRemovalMode } from '../lib/repeated_line_removal_flag.js';

describe('repeatedLineRemovalMode', () => {
  it.each([
    [{ REPEATED_LINE_REMOVAL_ENABLED: 'true' }, 'on'],
    [{ REPEATED_LINE_REMOVAL_ENABLED: 'shadow' }, 'shadow'],
    [{ REPEATED_LINE_REMOVAL_ENABLED: 'TRUE' }, 'off'],
    [{ REPEATED_LINE_REMOVAL_ENABLED: '' }, 'off'],
    [{}, 'off'],
  ])('reads %j as %s', (env, mode) => {
    expect(repeatedLineRemovalMode(env)).toBe(mode);
  });
});
