// Runtime configuration overrides.
//
// Preloaded with `node --import` by run-production.sh and run-development.sh.
// When the service imports a module from its own config directory
// (/usr/src/dist/config/...) and a file with the same relative path exists in
// /config, the file from /config is loaded instead.  Nothing is copied or
// written to disk: /config may be a read-only mount (e.g. a Kubernetes
// ConfigMap).
//
// - Only the config/ *directory* is affected, a plain config.js next to app.js
//   is never redirected.
// - A shipped config/foo.js may be overridden by /config/foo.js, foo.ts or
//   foo.coffee, as the sources used to be transpiled together.
// - Overrides are transpiled in memory with the template's babel (and
//   coffeescript), so they support the same syntax as the service's sources.
// - Relative imports from an override look in /config first and fall back to
//   the shipped config directory.  Other imports (mu, npm packages) resolve as
//   if the override lived in the shipped config directory.
// - Files in /config identical to the defaults copied there at build time are
//   ignored so the prebuilt sources are used.
// - Code reading /config directly (e.g. require('/config/config.json')) is not
//   affected.

import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_DIR = '/config';
const DIST_DIR = '/usr/src/dist';
const DIST_CONFIG_DIR = path.join(DIST_DIR, 'config');
const TEMPLATE_DIR = '/usr/src/app';
const DEFAULTS_MANIFEST = path.join(TEMPLATE_DIR, 'config-defaults.sha256');

// Sources in /config which may stand in for a compiled .js file, in order of
// preference.
const JS_SOURCE_EXTENSIONS = ['.js', '.ts', '.coffee'];
const TRANSPILED_EXTENSIONS = new Set(['.js', '.ts', '.coffee']);
const MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.coffee', '.json']);

const templateRequire = createRequire(path.join(TEMPLATE_DIR, 'package.json'));

if (typeof registerHooks !== 'function') {
  console.error(`[config] module.registerHooks is not available in Node ${process.version}; Node >= 22.15 is required for /config overrides.`);
  process.exit(1);
}

//==-- state --==//

// canonical file URL of a loaded override -> its path relative to the config dir
const overrides = new Map();
// real paths of /config files which were loaded as a module in any way
const loadedRealPaths = new Set();
const hashCache = new Map();
const defaultHashes = readDefaultHashes();
const jsFormat = readDistPackageType() === 'commonjs' ? 'commonjs' : 'module';
let babel, coffee;

//==-- helpers --==//

function readDefaultHashes() {
  const hashes = new Map();
  try {
    for (const line of fs.readFileSync(DEFAULTS_MANIFEST, 'utf8').split('\n')) {
      const match = line.match(/^([0-9a-f]{64}) [ *]\.\/(.*)$/);
      if (match) hashes.set(match[2], match[1]);
    }
  } catch (e) {
    // no defaults were copied to /config (e.g. development without build)
  }
  return hashes;
}

function readDistPackageType() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'package.json'), 'utf8')).type;
  } catch (e) {
    return 'module';
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile(); // follows symlinks
  } catch (e) {
    return false;
  }
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch (e) {
    return false;
  }
}

function isInside(dir, file) {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function fileHash(file) {
  if (!hashCache.has(file)) {
    hashCache.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  }
  return hashCache.get(file);
}

/**
 * A file in /config is an override unless it is the default which was copied
 * there at build time.
 */
function isOverride(relative) {
  const file = path.join(CONFIG_DIR, relative);
  if (!isFile(file)) return false;
  const defaultHash = defaultHashes.get(relative);
  return !defaultHash || defaultHash !== fileHash(file);
}

/**
 * Find the override in /config for a file in the shipped config dir.
 *
 * @param {string} relative Path relative to the config directory.
 * @return {string?} Relative path of the override in /config.
 */
function findOverride(relative) {
  const ext = path.extname(relative);
  const candidates = [relative];
  if (ext === '.js') {
    const base = relative.slice(0, -ext.length);
    candidates.push(...JS_SOURCE_EXTENSIONS.slice(1).map((e) => base + e));
    // babel rewrites a directory import to dir/index.js only when the
    // directory exists next to the importing file, so dir.js may mean dir/
    if (!isFile(path.join(DIST_CONFIG_DIR, relative))) {
      candidates.push(...JS_SOURCE_EXTENSIONS.map((e) => path.join(base, 'index' + e)));
    }
  }
  return candidates.find(isOverride);
}

function overrideResult(relative) {
  const realPath = fs.realpathSync(path.join(CONFIG_DIR, relative));
  const url = pathToFileURL(realPath).href;
  if (!overrides.has(url)) overrides.set(url, relative);
  loadedRealPaths.add(realPath);
  return { url, shortCircuit: true };
}

function isRelativeOrAbsolute(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..' || specifier.startsWith('/') || specifier.startsWith('file:');
}

function specifierPath(specifier, parentFile) {
  if (specifier.startsWith('file:')) return fileURLToPath(specifier);
  return path.resolve(path.dirname(parentFile), specifier);
}

function isNotFound(error) {
  return error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT');
}

//==-- hooks --==//

function resolve(specifier, context, nextResolve) {
  let parentURL = context.parentURL;
  const overrideOf = parentURL && overrides.get(parentURL);

  // Imports from an override resolve as if it lived in the shipped config dir.
  if (overrideOf !== undefined) {
    parentURL = pathToFileURL(path.join(DIST_CONFIG_DIR, overrideOf)).href;
    context = { ...context, parentURL };
  }

  if (parentURL && parentURL.startsWith('file:') && isRelativeOrAbsolute(specifier)) {
    const target = specifierPath(specifier, fileURLToPath(parentURL));
    if (isInside(DIST_CONFIG_DIR, target)) {
      const override = findOverride(path.relative(DIST_CONFIG_DIR, target));
      if (override) return overrideResult(override);
      // see findOverride: dir.js may refer to a shipped dir/index.js
      const base = target.slice(0, -'.js'.length);
      if (target.endsWith('.js') && !isFile(target) && isFile(path.join(base, 'index.js'))) {
        specifier = pathToFileURL(path.join(base, 'index.js')).href;
      }
    }
  }

  let result;
  try {
    result = nextResolve(specifier, context);
  } catch (error) {
    if (overrideOf !== undefined && isNotFound(error)) {
      throw new Error(`[config] Cannot resolve '${specifier}' imported from ${path.join(CONFIG_DIR, overrideOf)}: not found in ${CONFIG_DIR} nor in the service's config directory.`, { cause: error });
    }
    throw error;
  }

  if (result.url && result.url.startsWith('file:')) {
    const file = fileURLToPath(result.url);
    if (isInside(DIST_CONFIG_DIR, file)) {
      const override = findOverride(path.relative(DIST_CONFIG_DIR, file));
      if (override) return overrideResult(override);
    } else if (isInside(CONFIG_DIR, file)) {
      // service imports from /config directly
      loadedRealPaths.add(file);
    }
  }
  return result;
}

function load(url, context, nextLoad) {
  const relative = overrides.get(url);
  if (relative === undefined) return nextLoad(url, context);

  const ext = path.extname(relative);
  if (!TRANSPILED_EXTENSIONS.has(ext)) {
    // .mjs, .cjs and .json are loaded as is, as they were never transpiled
    return nextLoad(url, context);
  }

  const file = path.join(CONFIG_DIR, relative);
  try {
    return { format: jsFormat, source: transpile(file, ext), shortCircuit: true };
  } catch (error) {
    throw new Error(`[config] Failed to load configuration override ${file}: ${error.message}`, { cause: error });
  }
}

/**
 * Transpiles an override in memory, the way transpile-sources.sh transpiles
 * the service's sources at build time.
 */
function transpile(file, ext) {
  let source = fs.readFileSync(file, 'utf8');
  if (ext === '.coffee') {
    coffee ??= templateRequire('coffeescript');
    source = coffee.compile(source, { filename: file, inlineMap: true });
  }
  babel ??= templateRequire('@babel/core');
  const filename = ext === '.coffee' ? file.slice(0, -ext.length) + '.js' : file;
  const result = babel.transformSync(source, {
    filename,
    configFile: path.join(TEMPLATE_DIR, 'babel.config.json'),
    babelrc: false,
    sourceMaps: 'inline',
    sourceFileName: file,
  });
  if (!result) throw new Error('babel did not transpile the file');
  return result.code;
}

registerHooks({ resolve, load });

//==-- warnings --==//

/**
 * List files in /config, following symlinks but skipping ConfigMap internals
 * (..data, ..2024_01_01_...).
 */
function listConfigFiles(dir = CONFIG_DIR, relative = '') {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, relative));
  } catch (e) {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith('..'))
    .flatMap((name) => {
      const entry = path.join(relative, name);
      const full = path.join(dir, entry);
      if (isDirectory(full)) return listConfigFiles(dir, entry);
      if (isFile(full)) return [entry];
      return [];
    });
}

/**
 * Before, the contents of /config were copied into the service's config
 * directory.  Overrides which shadow a shipped default but are never loaded as
 * a module were probably read with fs from the service's config directory,
 * which no longer sees them.
 */
function warnAboutUnusedOverrides() {
  const unused = listConfigFiles()
    .filter((relative) => isOverride(relative))
    .filter((relative) => fs.existsSync(path.join(DIST_CONFIG_DIR, relative)) || defaultHashes.has(relative))
    .filter((relative) => !loadedRealPaths.has(fs.realpathSync(path.join(CONFIG_DIR, relative))));

  for (const relative of unused) {
    const ext = path.extname(relative);
    console.warn(`[config] WARNING: ${path.join(CONFIG_DIR, relative)} overrides the service's config/${relative} but was not loaded as a module.`
      + ` /config is no longer copied into the service's sources: if the service reads config/${relative} from its own directory (fs, __dirname),`
      + ` it now gets the shipped default. Read ${path.join(CONFIG_DIR, relative)} directly instead.`
      + (MODULE_EXTENSIONS.has(ext) ? ' Ignore this warning if the service imports it lazily or reads /config itself.' : ' Ignore this warning if the service reads /config itself.'));
  }
}

const warnDelay = Number(process.env.MU_CONFIG_WARN_DELAY_MS ?? 10000);
if (warnDelay >= 0) setTimeout(warnAboutUnusedOverrides, warnDelay).unref();
