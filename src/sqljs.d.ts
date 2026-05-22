declare module 'node:sqlite' {
  export interface DatabaseSyncOptions {
    readonly readOnly?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export interface StatementSync {
    get(...params: readonly unknown[]): unknown;
    run(...params: readonly unknown[]): unknown;
  }
}

declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export interface QueryResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Database {
    exec(sql: string, params?: unknown[]): QueryResult[];
    prepare(sql: string, params?: unknown[]): Statement;
    run(sql: string, params?: unknown[]): Database;
    export(): Uint8Array;
    close(): void;
  }

  export interface Statement {
    bind(values?: unknown[]): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }

  export interface InitSqlJsOptions {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
}

declare module 'sql.js/dist/sql-asm.js' {
  export { default } from 'sql.js';
}