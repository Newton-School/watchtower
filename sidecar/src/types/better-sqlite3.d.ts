declare module 'better-sqlite3' {
  namespace Database {
    interface Statement {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    }

    interface Database {
      pragma(statement: string): unknown;
      exec(sql: string): unknown;
      prepare(sql: string): Statement;
      // Wraps `fn` in a SQLite transaction, returning a function with the same
      // signature; better-sqlite3 commits on return and rolls back on throw.
      transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
      close(): void;
    }
  }

  interface DatabaseConstructor {
    new (path: string): Database.Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
