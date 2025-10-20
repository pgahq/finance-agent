declare module '@pga/lambda-env' {
  // Default export is the async function (module.exports = async (...))
  function loadEnv(ssm?: unknown, currentEnv?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>;
  export default loadEnv;
}

declare module '@pga/logger' {
  export function debug(message: string, ...args: unknown[]): void;
  export function info(message: string, ...args: unknown[]): void;
  export function warn(message: string, ...args: unknown[]): void;
  export function error(message: string, ...args: unknown[]): void;
}

