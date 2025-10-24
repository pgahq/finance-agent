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

declare module 'strong-soap' {
  export interface WSSecurity {
    new (username: string, password: string, options?: any): any;
  }

  export interface SoapClient {
    createClient(wsdlPath: string, options: any, callback: (err: any, client: any) => void): void;
    WSSecurity: WSSecurity;
  }

  export const soap: SoapClient;
}

declare module 'node-pdftocairo' {
  interface ConvertOptions {
    format?: string;
    firstPage?: number;
    lastPage?: number;
    resolution?: number;
  }

  function convert(pdfPath: string, outputPath: string, options?: ConvertOptions): Promise<string>;
  export default { convert };
}

