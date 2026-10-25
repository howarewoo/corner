import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const migrationsFolder = fileURLToPath(new URL('../migrations/', import.meta.url));
export interface MigrationIdentity {
  name: string;
  sha256: string;
  when: number;
  journalSha256: string;
  snapshotSha256: string;
}
const journalSchema = z
  .object({
    version: z.literal('7'),
    dialect: z.literal('postgresql'),
    entries: z
      .array(
        z
          .object({
            idx: z.number().int().nonnegative(),
            version: z.literal('7'),
            when: z.int().positive(),
            tag: z.string().regex(/^\d{4}_[A-Za-z0-9_-]+$/),
            breakpoints: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const snapshotSchema = z
  .object({
    id: z.guid(),
    prevId: z.guid(),
    version: z.literal('7'),
    dialect: z.literal('postgresql'),
    tables: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/** Validate Kit's complete execution inputs before its permissive reader sees them. */
export async function migrationInventory(folder = migrationsFolder): Promise<MigrationIdentity[]> {
  for (const path of [folder, join(folder, 'meta')]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid migration directory.');
  }
  const read = async (path: string) => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid migration input.');
    return readFile(path, 'utf8');
  };
  const journal = journalSchema.parse(JSON.parse(await read(join(folder, 'meta/_journal.json'))));
  const entries: MigrationIdentity[] = [];
  const metadata = ['_journal.json'];
  const tags = new Set<string>();
  let previousId = '00000000-0000-0000-0000-000000000000';
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.idx !== index || tags.has(entry.tag) || entry.when <= (entries.at(-1)?.when ?? 0))
      throw new Error('Invalid migration order.');
    tags.add(entry.tag);
    const snapshotName = `${String(index).padStart(4, '0')}_snapshot.json`;
    metadata.push(snapshotName);
    const snapshotBytes = await read(join(folder, 'meta', snapshotName));
    const snapshot = snapshotSchema.parse(JSON.parse(snapshotBytes));
    if (snapshot.prevId !== previousId || snapshot.id === previousId)
      throw new Error('Invalid migration snapshot lineage.');
    previousId = snapshot.id;
    const name = `${entry.tag}.sql`;
    entries.push({
      name,
      when: entry.when,
      sha256: createHash('sha256')
        .update(await read(join(folder, name)))
        .digest('hex'),
      journalSha256: createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
      snapshotSha256: createHash('sha256').update(snapshotBytes).digest('hex'),
    });
  }
  if (
    JSON.stringify((await readdir(folder)).sort()) !==
      JSON.stringify(['meta', ...entries.map((entry) => entry.name)].sort()) ||
    JSON.stringify((await readdir(join(folder, 'meta'))).sort()) !== JSON.stringify(metadata.sort())
  )
    throw new Error('Unlisted migration inputs.');
  return entries;
}
