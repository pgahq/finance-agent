process.env.OPENAI_API_KEY =
  process.env.EVALS_API_KEY
  ?? process.env.OPENAI_API_KEY
  ?? '';

if (process.env.RUN_EVALS === '1' && !process.env.LLM_MODEL) {
  process.env.LLM_MODEL = 'gpt-5.4-mini';
}

if (process.env.EVAL_DATABASE_URL) {
  process.env.DATABASE_URL ??= process.env.EVAL_DATABASE_URL;
  process.env.DATABASE_SKIP_IVFFLAT_INDEX = '1';
}

export function requireEvalEnv(): void {
  if (process.env.RUN_EVALS !== '1') {
    return;
  }

  const hasDirectOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
  const hasGatewayKey = Boolean(process.env.AI_GATEWAY_API_KEY);

  if (!hasDirectOpenAiKey && !hasGatewayKey) {
    throw new Error(
      'Evals require EVALS_API_KEY, OPENAI_API_KEY, or AI_GATEWAY_API_KEY when RUN_EVALS=1'
    );
  }
}
