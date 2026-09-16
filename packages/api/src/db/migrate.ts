import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction, closePool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applies .sql files in filename order, once each, tracked in schema_migrations.
 * No migration framework — this is a handful of files on a single machine.
 */
export async function migrate(log: (msg: string) => void = console.log): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    // Each migration is one transaction: a half-applied schema is worse than none.
    await withTransaction(async (db) => {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    log(`applied ${file}`);
    ran.push(file);
  }

  if (ran.length === 0) log('no pending migrations');
  return ran;
}

// Only run when invoked directly (npm run migrate), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => closePool())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
