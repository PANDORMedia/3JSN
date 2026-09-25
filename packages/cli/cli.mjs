#!/usr/bin/env node
import { buildProject } from './build.mjs';
import { buildViteProject } from './vite-build.mjs';
import { BuildError } from './contract.mjs';

const usage = '3jsn build <project> --runtime <player> --out <new-directory> --experimental [--targets <host-target>] [--font <font.woff2> (dom-window-v1 only)] [--bundle-web-fonts [--web-fonts-state <directory>] [--offline]]\n3jsn vite-build <project> --out <new-directory>';
const controller = new AbortController();
let interruptedBy;
const interrupt = signal => { interruptedBy ??= signal; controller.abort(); };
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  const [command, project, ...args] = process.argv.slice(2);
  if (!['build', 'vite-build'].includes(command) || !project || project.startsWith('--')) throw new BuildError('USAGE', usage);
  const options = { project, signal: controller.signal };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const flags = command === 'vite-build' ? { '--out': 'out' } : { '--runtime': 'runtime', '--out': 'out', '--targets': 'targets', '--experimental': 'experimental', '--font': 'font',
      '--bundle-web-fonts': 'bundleWebFonts', '--web-fonts-state': 'webFontsState', '--offline': 'offline' };
    const key = flags[flag];
    if (!key || Object.hasOwn(options, key)) throw new BuildError('USAGE', usage);
    if (['experimental', 'bundleWebFonts', 'offline'].includes(key)) options[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new BuildError('USAGE', usage);
      options[key] = value;
    }
  }
  console.log(JSON.stringify(command === 'vite-build' ? await buildViteProject(options) : await buildProject(options)));
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? 'BUILD_FAILED', message: error.message,
    ...(error.receipt ? { receipt: error.receipt } : {}),
    ...(error.sourcePreserved !== undefined ? { sourcePreserved: error.sourcePreserved } : {}),
    ...(error.source ? { source: { before: error.source.before?.digest ?? null, after: error.source.after?.digest ?? null,
      preserved: error.source.preservation?.preserved ?? null, changes: error.source.preservation?.changes ?? null } } : {}),
    ...(error.receiptError ? { receiptError: error.receiptError } : {}),
    ...(error.cleanupErrors ? { cleanupErrors: error.cleanupErrors } : {}),
  } }));
  process.exitCode = error.code === 'CANCELLED' ? (interruptedBy === 'SIGTERM' ? 143 : 130)
    : ['USAGE', 'UNSUPPORTED_TARGET', 'UNSUPPORTED_HOST', 'EXPERIMENTAL_REQUIRED'].includes(error.code) ? 2 : 1;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
