import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

export default function format(omp) {
  omp.on('tool_result', async (event, ctx) => {
    if (event.isError || !['write', 'edit', 'apply_patch'].includes(event.toolName)) return;

    try {
      const root = await realpath(projectRoot);
      const candidates =
        event.toolName === 'write'
          ? [event.input.path]
          : (event.details?.perFileResults ?? [event.details])
              .filter((file) => file && file.op !== 'delete')
              .map((file) => file.path);
      const paths = new Set();

      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate.includes('://')) continue;
        let path;
        try {
          path = await realpath(resolve(ctx.cwd, candidate));
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
          throw error;
        }
        const withinRoot = relative(root, path);
        if (
          !withinRoot ||
          withinRoot === '..' ||
          withinRoot.startsWith(`..${sep}`) ||
          isAbsolute(withinRoot) ||
          !(await stat(path)).isFile()
        ) {
          continue;
        }
        paths.add(`.${sep}${withinRoot}`);
      }
      if (paths.size === 0) return;

      await run('pnpm', ['run', 'format', ...paths], { cwd: root, timeout: 20_000 });
      return {
        additionalContext:
          'The post-write format hook has run. Re-read touched files before using hashline anchors or relying on pre-format snapshots.',
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          ...event.content,
          {
            type: 'text',
            text: `The file mutation succeeded, but post-write formatting failed: ${error.message}`,
          },
        ],
      };
    }
  });
}
