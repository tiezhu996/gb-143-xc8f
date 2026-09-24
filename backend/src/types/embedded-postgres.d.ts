// embedded-postgres 为 ESM-only 包，测试脚本通过动态 import 使用
declare module 'embedded-postgres' {
  export interface EmbeddedPostgresOptions {
    databaseDir?: string;
    user?: string;
    password?: string;
    port?: number;
    persistent?: boolean;
    initdbFlags?: string[];
    postgresFlags?: string[];
  }

  export default class EmbeddedPostgres {
    constructor(options?: EmbeddedPostgresOptions);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
    getDatabase(name: string): any;
  }
}
