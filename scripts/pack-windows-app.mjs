// Local Windows installer build: never execute the intermediate installer.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32') throw new Error('This local installer build requires Windows.');
// This adapter depends on the pinned builder's NSIS implementation. Fail on upgrades.
if (require('app-builder-lib/package.json').version !== '26.15.3') {
  throw new Error('Review the static NSIS adapter before upgrading electron-builder.');
}
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
const { UninstallerReader, nsisTemplatesDir } = require('app-builder-lib/out/targets/nsis/nsisUtil.js');

NsisTarget.prototype.computeScriptAndSignUninstaller = async function (defines, commands, installerPath, sharedHeader, archs) {
  const customScript = await this.packager.getResource(this.options.script, 'installer.nsi');
  if (customScript) throw new Error('The static NSIS adapter supports the standard installer template only.');
  const script = await readFile(join(nsisTemplatesDir, 'installer.nsi'), 'utf8');
  const uninstallerPath = join(this.outDir, 'bb-dashboard-cuhksz-static-uninstaller.exe');
  defines.BUILD_UNINSTALLER = null;
  defines.UNINSTALLER_OUT_FILE = uninstallerPath;
  await this.executeMakensis(defines, commands, sharedHeader + await this.computeFinalScript(script, false, archs));
  // The builder uses this same PE/NSIS reader on macOS. It reads bytes and
  // writes the embedded uninstaller; no generated EXE is launched or installed.
  await UninstallerReader.exec(installerPath, uninstallerPath);
  await this.packager.signIf(uninstallerPath);
  delete defines.BUILD_UNINSTALLER;
  defines.UNINSTALLER_OUT_FILE = uninstallerPath;
  return { script, isCustomScript: false };
};

const cache = join(root, '.work', 'installer-build-cache');
await mkdir(cache, { recursive: true });
// Downloaded builder tools are CommonJS; isolate them from this ESM package.
await writeFile(join(cache, 'package.json'), '{"type":"commonjs","private":true}\n');
process.env.ELECTRON_BUILDER_CACHE = cache;
process.env.TEMP = cache;
process.env.TMP = cache;
process.env.CSC_IDENTITY_AUTO_DISCOVERY ??= 'false';
await build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  config: { electronDist: join(dirname(require.resolve('electron/package.json')), 'dist') },
  publish: 'never',
});
