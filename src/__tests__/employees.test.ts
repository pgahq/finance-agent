import { employeeDisplayName, getEmployeeWidByEmail } from '../lib/employees.js';

describe('employeeDisplayName', () => {
  it('prefers preferredName over legal name', () => {
    expect(employeeDisplayName({
      name: 'Joseph A Carey Jr.',
      preferredName: 'Joe Carey',
    })).toBe('Joe Carey');
  });

  it('falls back to legal name when preferredName is missing or blank', () => {
    expect(employeeDisplayName({ name: 'Joseph A Carey Jr.' })).toBe('Joseph A Carey Jr.');
    expect(employeeDisplayName({ name: 'Joseph A Carey Jr.', preferredName: '  ' })).toBe('Joseph A Carey Jr.');
  });

  it('returns undefined when both names are missing', () => {
    expect(employeeDisplayName({})).toBeUndefined();
  });
});

describe('getEmployeeWidByEmail', () => {
  it('returns a match when exactly one employee row exists', async () => {
    const db = {
      query: jest.fn().mockResolvedValue([{
        workday_id: 'wid-123',
        metadata: { name: 'Joseph A Carey Jr.', preferredName: 'Joe Carey', email: 'jcarey@pgahq.com' },
      }]),
    };

    await expect(getEmployeeWidByEmail(db as any, 'jcarey@pgahq.com')).resolves.toEqual({
      workdayId: 'wid-123',
      name: 'Joseph A Carey Jr.',
      preferredName: 'Joe Carey',
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("metadata->>'active'"),
      ['jcarey@pgahq.com'],
    );
  });

  it('returns legal name without preferredName when the cache row has none', async () => {
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

  it('returns undefined when the database query fails', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('connection reset')) };
    await expect(getEmployeeWidByEmail(db as any, 'jcarey@pgahq.com')).resolves.toBeUndefined();
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
