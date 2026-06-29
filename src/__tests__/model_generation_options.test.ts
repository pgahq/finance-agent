import { modelSupportsTemperature, temperatureOption } from '../lib/model_generation_options.js';

describe('model_generation_options', () => {
  it('omits temperature for GPT-5 and o-series reasoning models', () => {
    expect(modelSupportsTemperature('gpt-5.4-mini')).toBe(false);
    expect(modelSupportsTemperature('gpt-5.4')).toBe(false);
    expect(modelSupportsTemperature('o3-mini')).toBe(false);
    expect(temperatureOption('gpt-5.4-mini', 0)).toEqual({});
  });

  it('includes temperature for other models', () => {
    expect(modelSupportsTemperature('gpt-4o')).toBe(true);
    expect(temperatureOption('gpt-4o', 0.2)).toEqual({ temperature: 0.2 });
  });
});
