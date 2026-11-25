import {
  eventNameOf,
  knownSectionCodesOf,
  parseEventText,
  rankEventCandidates,
  resolveEventCoding,
  type EventCandidate,
} from '../lib/event_match.js';

// Fictional catalog shaped like the real cache: one main event per year, plus per-section copies named
// "<yy><SECTION>-<Name>" with underscores and the abbreviation "Jr".
const MAIN_2026 = { workdayId: 'wid-main-2026', name: '2026 Lakeside Junior Skills Series' };
const MAIN_2025 = { workdayId: 'wid-main-2025', name: '2025 Lakeside Junior Skills Series' };
const QX_25 = { workdayId: 'wid-qx-25', name: '25QX-Lakeside_Junior_Skills_Series_Season' };
const QX_27 = { workdayId: 'wid-qx-27', name: '27QX-Lakeside_Junior_Skills_Series_Season' };
const ZB_26 = { workdayId: 'wid-zb-26', name: '26ZB-Lakeside_Jr_Skills_Series' };
const ZB_27 = { workdayId: 'wid-zb-27', name: '27ZB-Lakeside_Jr_Skills_Series' };
const HARBOR = { workdayId: 'wid-harbor-2026', name: '2026 Harbor Open Championship' };

const CATALOG: EventCandidate[] = [QX_25, QX_27, ZB_27, ZB_26, MAIN_2025, HARBOR, MAIN_2026];
const KNOWN = knownSectionCodesOf(CATALOG.map(event => event.name));

describe('knownSectionCodesOf', () => {
  it('learns section codes from year-prefixed names only', () => {
    expect([...KNOWN].sort()).toEqual(['QX', 'ZB']);
  });
});

describe('parseEventText', () => {
  it.each([
    ['26 Lakeside Jr. Skills Series', 2026, null, ['lakeside', 'junior', 'skills', 'series']],
    ['2026 Lakeside Junior Skills Series', 2026, null, ['lakeside', 'junior', 'skills', 'series']],
    ["Lakeside Jr Skills Series '26", 2026, null, ['lakeside', 'junior', 'skills', 'series']],
    ['FY26 Lakeside Junior Skills Series', 2026, null, ['lakeside', 'junior', 'skills', 'series']],
    ['Lakeside Junior Skills Series', null, null, ['lakeside', 'junior', 'skills', 'series']],
    ['26ZB-Lakeside_Jr_Skills_Series', 2026, 'ZB', ['lakeside', 'junior', 'skills', 'series']],
    ['26ZB Lakeside Jr. Skills Series', 2026, 'ZB', ['lakeside', 'junior', 'skills', 'series']],
    ['26 ZB Lakeside Jr. Skills Series', 2026, 'ZB', ['lakeside', 'junior', 'skills', 'series']],
  ])('reads %s', (text, year, sectionCode, tokens) => {
    expect(parseEventText(text, KNOWN)).toEqual({ year, sectionCode, tokens });
  });

  it('does not read a number or an ordinary word as a year or section', () => {
    expect(parseEventText('Top 18 Hole Challenge', KNOWN)).toEqual({ year: null, sectionCode: null, tokens: ['top', '18', 'hole', 'challenge'] });
    expect(parseEventText('Zb lakeside', KNOWN).sectionCode).toBeNull();
    expect(parseEventText('Lakeside Series 45', KNOWN).year).toBeNull();
  });

  it('expands the common abbreviations and drops filler words', () => {
    expect(parseEventText("Sr. Women's Natl Champ & the Invit", KNOWN).tokens).toEqual(['senior', 'womens', 'national', 'championship', 'invitational']);
  });
});

describe('eventNameOf', () => {
  it('prefers the metadata name and falls back to the cached content', () => {
    expect(eventNameOf({ metadata: { name: ' 2026 Harbor Open Championship ' }, content: 'Event Name: other' })).toBe('2026 Harbor Open Championship');
    expect(eventNameOf({ metadata: {}, content: 'Event Name: 2026 Harbor Open Championship' })).toBe('2026 Harbor Open Championship');
  });
});

describe('rankEventCandidates', () => {
  it('matches the main event for an abbreviated name with a two-digit year, not a section copy', () => {
    const ranking = rankEventCandidates('26 Lakeside Jr. Skills Series', CATALOG);

    expect(ranking.recommended?.workdayId).toBe(MAIN_2026.workdayId);
    expect(ranking.recommended?.tier).toBe('exact');
    expect(ranking.ambiguous).toEqual([]);
    expect(ranking.ranked.map(event => event.workdayId)).toEqual([MAIN_2026.workdayId]);
  });

  it('matches a section copy only when the email names that section', () => {
    expect(rankEventCandidates('26ZB Lakeside Jr. Skills Series', CATALOG).recommended?.workdayId).toBe(ZB_26.workdayId);
    expect(rankEventCandidates('Lakeside Jr. Skills Series 26 ZB', CATALOG).recommended?.workdayId).toBe(ZB_26.workdayId);
  });

  it('never matches a section copy of another section or year', () => {
    expect(rankEventCandidates('26QX Lakeside Jr. Skills Series', CATALOG).recommended).toBeNull();
    expect(rankEventCandidates('2025 ZB Lakeside Jr. Skills Series', CATALOG).recommended).toBeNull();
  });

  it('prefers the year the email names over other years', () => {
    expect(rankEventCandidates('2025 Lakeside Junior Skills Series', CATALOG).recommended?.workdayId).toBe(MAIN_2025.workdayId);
    expect(rankEventCandidates('Lakeside Junior Skills Series 2026', CATALOG).recommended?.workdayId).toBe(MAIN_2026.workdayId);
  });

  it('does not use another year when the email names a year that has no event', () => {
    const ranking = rankEventCandidates('2024 Lakeside Junior Skills Series', CATALOG);

    expect(ranking.recommended).toBeNull();
    expect(ranking.ambiguous).toEqual([]);
  });

  it('uses the preferred year only when the email names none, and calls a tie across years ambiguous without it', () => {
    const tied = rankEventCandidates('Lakeside Jr Skills Series', CATALOG);
    expect(tied.recommended).toBeNull();
    expect(tied.ambiguous.map(event => event.workdayId).sort()).toEqual([MAIN_2025.workdayId, MAIN_2026.workdayId].sort());

    expect(rankEventCandidates('Lakeside Jr Skills Series', CATALOG, { preferredYear: 2026 }).recommended?.workdayId).toBe(MAIN_2026.workdayId);
    expect(rankEventCandidates('Lakeside Jr Skills Series 2025', CATALOG, { preferredYear: 2026 }).recommended?.workdayId).toBe(MAIN_2025.workdayId);
  });

  it('prefers the event with the same words over one that adds words', () => {
    const season = { workdayId: 'wid-main-2026-season', name: '2026 Lakeside Junior Skills Series Season' };
    const ranking = rankEventCandidates('26 Lakeside Jr Skills Series', [season, MAIN_2026]);

    expect(ranking.recommended?.workdayId).toBe(MAIN_2026.workdayId);
    expect(ranking.ranked.map(event => event.tier)).toEqual(['exact', 'contains']);
  });

  it('prefers the event with fewer added words, and calls equal ones ambiguous instead of using WID order', () => {
    const a = { workdayId: 'wid-a', name: '2026 Harbor Open Championship Gala' };
    const b = { workdayId: 'wid-b', name: '2026 Harbor Open Championship Dinner' };
    const long = { workdayId: 'wid-long', name: '2026 Harbor Open Championship Gala Dinner Weekend' };

    expect(rankEventCandidates('2026 Harbor Open', [long, a]).recommended?.workdayId).toBe('wid-a');
    const tied = rankEventCandidates('2026 Harbor Open', [b, a]);
    expect(tied.recommended).toBeNull();
    expect(tied.ambiguous.map(event => event.workdayId).sort()).toEqual(['wid-a', 'wid-b']);
  });

  it('ranks events matched only by meaning last, by similarity, and never recommends them', () => {
    const ranking = rankEventCandidates('Lakeside Skills Showcase', [
      { ...HARBOR, similarity: 0.5 },
      { ...MAIN_2026, similarity: 0.7 },
    ]);

    expect(ranking.ranked.map(event => [event.workdayId, event.tier])).toEqual([
      [MAIN_2026.workdayId, 'semantic'],
      [HARBOR.workdayId, 'semantic'],
    ]);
    expect(ranking.recommended).toBeNull();
    expect(ranking.ambiguous).toEqual([]);
  });

  it('keeps semantic matches out of a ranking that has word matches ahead of them', () => {
    const ranking = rankEventCandidates('26 Lakeside Jr. Skills Series', [
      { ...ZB_26, similarity: 0.99 },
      { ...HARBOR, similarity: 0.6 },
      { ...MAIN_2026, similarity: 0.6 },
    ]);

    expect(ranking.recommended?.workdayId).toBe(MAIN_2026.workdayId);
    expect(ranking.ranked.map(event => event.workdayId)).toEqual([MAIN_2026.workdayId, HARBOR.workdayId]);
  });

  it('prefers the preferred year before the wording tier when the email names no year', () => {
    const season2026 = { workdayId: 'wid-main-2026-season', name: '2026 Lakeside Junior Skills Series Season' };
    const ranking = rankEventCandidates('Lakeside Jr Skills Series', [MAIN_2025, season2026], { preferredYear: 2026 });

    expect(ranking.recommended?.workdayId).toBe(season2026.workdayId);
    expect(ranking.ranked.map(event => event.workdayId)).toEqual([season2026.workdayId, MAIN_2025.workdayId]);
  });

  it('matches a cached event whose name carries no year, even when the email names one', () => {
    const yearless = { workdayId: 'wid-annual', name: 'Harbor Annual Meeting' };

    expect(rankEventCandidates('2026 Harbor Annual Meeting', [yearless, MAIN_2026]).recommended?.workdayId).toBe(yearless.workdayId);
  });

  it('reads an attached section code only in uppercase, like a standalone one', () => {
    expect(parseEventText('26zb Lakeside Jr. Skills Series', KNOWN).sectionCode).toBeNull();
    expect(rankEventCandidates('26zb Lakeside Jr. Skills Series', CATALOG).recommended).toBeNull();
  });

  it('keeps the word "a" so distinct names stay distinct', () => {
    const withArticle = { workdayId: 'wid-a-team', name: '2026 A Team Classic' };
    const without = { workdayId: 'wid-team', name: '2026 Team Classic' };

    expect(rankEventCandidates('2026 A Team Classic', [without, withArticle]).recommended?.workdayId).toBe('wid-a-team');
    expect(rankEventCandidates('2026 Team Classic', [withArticle, without]).recommended?.workdayId).toBe('wid-team');
  });

  it('counts a repeated cache row once and ignores a row with no name', () => {
    const ranking = rankEventCandidates('26 Lakeside Jr. Skills Series', [MAIN_2026, { ...MAIN_2026 }, { workdayId: 'wid-blank', name: '  ' }]);

    expect(ranking.recommended?.workdayId).toBe(MAIN_2026.workdayId);
    expect(ranking.ranked).toHaveLength(1);
  });

  it('drops a WID whose rows disagree on the name, so row order cannot choose', () => {
    const conflicting = [{ workdayId: 'wid-x', name: '2026 Lakeside Junior Skills Series' }, { workdayId: 'wid-x', name: '2025 Lakeside Junior Skills Series' }];

    expect(rankEventCandidates('Lakeside Jr Skills Series', conflicting).ranked).toEqual([]);
    expect(rankEventCandidates('Lakeside Jr Skills Series', [...conflicting].reverse()).ranked).toEqual([]);
  });

  it('learns section codes only from a valid year prefix', () => {
    expect([...knownSectionCodesOf(['2100ZB-Event', '26QX-Event', '3AB-Event'])]).toEqual(['QX']);
    expect(parseEventText('2100ZB-Event').sectionCode).toBeNull();
  });

  it('does not treat a known section code inside ordinary lowercase prose as a section', () => {
    const parsed = parseEventText('26 Lakeside Jr. Skills Series zb', KNOWN);

    expect(parsed.sectionCode).toBeNull();
    expect(parsed.tokens).toContain('zb');
  });

  it('returns nothing for an empty query', () => {
    expect(rankEventCandidates('26', CATALOG).ranked).toEqual([]);
  });
});

describe('resolveEventCoding', () => {
  const coding = (extracted: string | null, workdayId: string | null) => ({ extracted, workdayId });

  it('replaces the section event the model picked with the main event and records its name', () => {
    expect(resolveEventCoding(coding('26 Lakeside Jr. Skills Series', ZB_26.workdayId), CATALOG)).toEqual({
      extracted: '26 Lakeside Jr. Skills Series',
      workdayId: MAIN_2026.workdayId,
      name: MAIN_2026.name,
    });
  });

  it('fills the event when the model left it empty', () => {
    expect(resolveEventCoding(coding('2026 Lakeside Junior Skills Series', null), CATALOG)).toMatchObject({ workdayId: MAIN_2026.workdayId });
  });

  it('clears a tie and lists the events that fit', () => {
    const result = resolveEventCoding(coding('Lakeside Jr Skills Series', MAIN_2025.workdayId), CATALOG);

    expect(result).toEqual({
      extracted: 'Lakeside Jr Skills Series',
      workdayId: null,
      ambiguousNames: expect.arrayContaining([MAIN_2025.name, MAIN_2026.name]),
    });
  });

  it('keeps a pick the rules do not contradict, and clears one they do', () => {
    expect(resolveEventCoding(coding('Open Championship Gala', HARBOR.workdayId), CATALOG)).toEqual({
      extracted: 'Open Championship Gala', workdayId: HARBOR.workdayId, name: HARBOR.name,
    });
    expect(resolveEventCoding(coding('2025 Open Championship Gala', HARBOR.workdayId), CATALOG)).toEqual({
      extracted: '2025 Open Championship Gala', workdayId: null,
    });
    expect(resolveEventCoding(coding('Quarterly Gala', ZB_26.workdayId), CATALOG)).toMatchObject({ workdayId: null });
    expect(resolveEventCoding(coding('Quarterly Gala', 'wid-not-cached'), CATALOG)).toMatchObject({ workdayId: null });
  });

  it('leaves an unresolved event and an absent event alone', () => {
    const unresolved = coding('Quarterly Gala', null);
    expect(resolveEventCoding(unresolved, CATALOG)).toBe(unresolved);
    expect(resolveEventCoding(null, CATALOG)).toBeNull();
    expect(resolveEventCoding(coding(null, null), CATALOG)).toEqual(coding(null, null));
  });

  it('clears a WID that has no event text to check it against', () => {
    expect(resolveEventCoding(coding(null, 'wid-main-2026'), CATALOG)).toEqual(coding(null, null));
    expect(resolveEventCoding(coding('  ', 'wid-main-2026'), CATALOG)).toEqual(coding('  ', null));
  });
});
