import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';

const SEED_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../../seeds/menu.sql');

export async function seed(): Promise<void> {
  await pool.query(await readFile(SEED_FILE, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => {
      console.log('seeded');
      return closePool();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
