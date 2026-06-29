export function requireEvalEnv(): void {
  if (process.env.RUN_EVALS !== '1') {
    return;
  }

  if (!process.env.EVALS_API_KEY) {
    throw new Error('Evals require EVALS_API_KEY when RUN_EVALS=1');
  }

  process.env.OPENAI_API_KEY = process.env.EVALS_API_KEY;
}
