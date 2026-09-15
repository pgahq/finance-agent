import { getEmployeeWidByEmail } from '../lib/employees.js';

describe('getEmployeeWidByEmail', () => {
  it('returns a match when exactly one employee row exists', async () => {
    const db = {
      query: jest.fn().mockResolvedValue([{
        workday_id: 'wid-123',
        metadata: { name: 'Joe Carey', email: 'jcarey@pgahq.com' },
      }]),
    };

    await expect(getEmployeeWidByEmail(db as any, 'jcarey@pgahq.com')).resolves.toEqual({
      workdayId: 'wid-123',
      name: 'Joe Carey',
    });
  });

  it('returns undefined when no rows match', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    await expect(getEmployeeWidByEmail(db as any, 'missing@pgahq.com')).resolves.toBeUndefined();
  });

  it('returns undefined when duplicate emails exist', async () => {
    const db = {
      query: jest.fn().mockResolvedValue([
        { workday_id: 'wid-1', metadata: {} },
        { workday_id: 'wid-2', metadata: {} },
      ]),
    };
    await expect(getEmployeeWidByEmail(db as any, 'dup@pgahq.com')).resolves.toBeUndefined();
  });
});
