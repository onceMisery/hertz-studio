// SPDX-License-Identifier: MIT
// Synchronous classic-script packaging: one Three.js/module graph, three public APIs.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withProgramAdmission } from './three-program-admission.mjs';
import { withBufferAdmission } from './three-buffer-admission.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const here = resolve(root, 'tools/space-stage');
const stageRequire = createRequire(resolve(here, 'package.json'));
let build;
try {
  ({ build } = stageRequire('esbuild'));
  if (!existsSync(resolve(here, 'node_modules/three/build/three.module.js'))) {
    throw new Error('Three.js entrypoint is missing');
  }
} catch (error) {
  throw new Error('Shared stage build dependencies are missing. Run `npm ci --prefix tools/space-stage --no-audit --no-fund` first.', { cause: error });
}
const stages = { coast: 'CoastStagePure', zodiac: 'ZodiacStagePure', space: 'SpaceStagePure' };
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
const vendor = resolve(root, 'plugin/ui/vendor');
mkdirSync(vendor, { recursive: true });
const result = await build({
  stdin: { contents: Object.entries(stages).map(([id, api]) => `export * as ${api} from './${id}-stage/src/main.js';`).join('\n'), resolveDir: resolve(root, 'tools'), sourcefile: 'stage-entrypoints.js' },
  bundle: true, format: 'iife', globalName: 'HertzStageRuntime', minify: !process.argv.includes('--dev'),
  target: 'es2020', legalComments: 'eof', write: false, metafile: true,
  plugins: [{ name: 'ktx2-transcoder-urls', setup(builder) {
    // The IIFE bundle has no import.meta. Inline the pinned Basis transcoder as
    // data URLs so KTX2Loader can build its worker without extra served files.
    const basis = resolve(here, 'node_modules/three/examples/jsm/libs/basis');
    const transcoderJS = readFileSync(resolve(basis, 'basis_transcoder.js')).toString('base64');
    const transcoderWasm = readFileSync(resolve(basis, 'basis_transcoder.wasm')).toString('base64');
    builder.onLoad({ filter: /[\\/]loaders[\\/]KTX2Loader\.js$/ }, args => {
      const source = readFileSync(args.path, 'utf8');
      const contents = source.replace(
        /const WASM_BIN_URL = new URL\([^;]+;\s*const WASM_JS_URL = new URL\([^;]+;/,
        `const WASM_BIN_URL = 'data:application/wasm;base64,${transcoderWasm}';\n`
        + `const WASM_JS_URL = 'data:text/javascript;base64,${transcoderJS}';`);
      if (contents === source) throw new Error('KTX2Loader transcoder URL layout changed');
      return { contents, loader: 'js', resolveDir: dirname(args.path) };
    });
  } }, { name: 'single-three-version', setup(builder) {
    builder.onLoad({ filter: /postprocessing[\\/]Pass\.js$/ }, args => {
      let contents = readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n');
      const replace = (from, to) => {
        if (contents.split(from).length !== 2) throw new Error('Three Pass admission source changed');
        contents = contents.replace(from, to);
      };
      // Fullscreen geometry belongs to a pass, is created only on its first
      // render and uses that renderer's page port. No allocation at evaluation.
      replace('const _geometry = new FullscreenTriangleGeometry();', '');
      replace('this._mesh = new Mesh( _geometry, material );',
        'this._mesh = new Mesh( new BufferGeometry(), material );\n\t\tthis._hertzReady = false;\n\t\tthis._hertzCpu = null;');
      replace('this._mesh.geometry.dispose();',
        'this._mesh.geometry.dispose();\n\t\tthis._hertzCpu?.release({ apiReleased: true, allocationEnded: true });\n\t\tthis._hertzCpu = null;\n\t\tthis._hertzReady = false;');
      replace('renderer.render( this._mesh, _camera );', `if (!this._hertzReady) {
          this._hertzCpu = renderer.hertzBufferResources?.require({ ownedCpuBytes: 15 * 12 },
            'Three FullScreenQuad original Float32 position9 uv6 and JS source arrays', 0);
          this._mesh.geometry = new FullscreenTriangleGeometry();
          this._hertzCpu?.commit({ ownedCpuBytes: 15 * 4 });
          this._hertzReady = true;
        }
        renderer.render( this._mesh, _camera );`);
      return { contents, loader: 'js', resolveDir: dirname(args.path) };
    });
    builder.onResolve({ filter: /^three(?:\/|$)/ }, args => ({ path: args.path === 'three' ? resolve(here, 'node_modules/three/build/three.module.js') : stageRequire.resolve(args.path) }));
    builder.onLoad({ filter: /three[\\/]build[\\/]three\.module\.js$/ }, args => ({
      contents: withBufferAdmission(withProgramAdmission(readFileSync(args.path, 'utf8'))), loader: 'js', resolveDir: dirname(args.path)
    }));
  } }],
});
writeFileSync(resolve(vendor, 'stage-runtime.js'), '// SPDX-License-Identifier: MIT\n// Generated by node tools/build-stages.mjs. Shared Three.js r186 and scene modules.\n' + result.outputFiles[0].text);
for (const [id, api] of Object.entries(stages)) {
  writeFileSync(resolve(vendor, `${id}-stage.js`), `// SPDX-License-Identifier: MIT\n// Generated by node tools/build-stages.mjs; stage-runtime.js must load first.\nvar ${api} = HertzStageRuntime.${api};\n`);
}
for (const id of Object.keys(stages)) {
  const manifest = {};
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = resolve(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else manifest[relative(root, file).replaceAll('\\', '/')] = hash(file);
    }
  }
  for (const source of Object.keys(stages)) scan(resolve(root, `tools/${source}-stage/src`));
  for (const file of ['tools/build-stages.mjs', 'tools/three-program-admission.mjs', 'tools/three-buffer-admission.mjs', ...Object.keys(stages).map(name => `tools/${name}-stage/build.mjs`), 'tools/space-stage/package.json', 'tools/space-stage/package-lock.json', 'plugin/ui/vendor/stage-runtime.js', ...Object.keys(stages).map(name => `plugin/ui/vendor/${name}-stage.js`)]) manifest[file] = hash(resolve(root, file));
  writeFileSync(resolve(root, `tools/${id}-stage/.build-manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`Shared stages: ${result.outputFiles[0].contents.length} bytes; one classic-script runtime, three synchronous APIs.`);
