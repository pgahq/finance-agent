export function modelSupportsTemperature(model: string): boolean {
  const modelId = model.replace(/^openai\//, '').toLowerCase();

  if (/^o\d/.test(modelId)) {
    return false;
  }

  if (modelId.startsWith('gpt-5')) {
    return false;
  }

  return true;
}

export function temperatureOption(
  model: string,
  temperature: number
): { temperature: number } | Record<string, never> {
  return modelSupportsTemperature(model) ? { temperature } : {};
}
