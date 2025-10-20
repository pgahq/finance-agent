declare module '@pga/lambda-env' {
  function loadEnv(): Promise<NodeJS.ProcessEnv>;
  export = { loadEnv };
}

declare module '@pga/logger' {
  export function debug(message: string, ...args: unknown[]): void;
  export function info(message: string, ...args: unknown[]): void;
  export function warn(message: string, ...args: unknown[]): void;
  export function error(message: string, ...args: unknown[]): void;
}

