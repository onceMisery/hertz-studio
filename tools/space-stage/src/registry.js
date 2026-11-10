import { PROFILES } from './quality.js';

const API_VERSION = 1;
const TYPES = new Set(['number', 'boolean', 'select', 'color', 'string']);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function validateValue(key, spec, value) {
  if (spec.type === 'number' && (!Number.isFinite(value) || value < spec.min || value > spec.max)) throw new Error(`Parameter ${key} outside range`);
  if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Parameter ${key} must be boolean`);
  if (spec.type === 'select' && !spec.options.some(option => (typeof option === 'object' ? option.value : option) === value)) throw new Error(`Parameter ${key} not an option`);
  if (spec.type === 'color' && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) throw new Error(`Parameter ${key} must be a hex color`);
  if (spec.type === 'string' && (typeof value !== 'string' || value.length > (spec.maxLength || 256))) throw new Error(`Parameter ${key} must be bounded text`);
  return value;
}
function validateComposition(input, params) {
  if (input.composition === undefined) return undefined;
  const value = clone(input.composition);
  const record = (object, keys, label) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(object, key))) throw new Error(`Invalid composition ${label}`);
  };
  const count = (number, label) => {
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid composition ${label}`);
  };
  if (JSON.stringify(value).length > 16384) throw new Error('Composition metadata exceeds bound');
  record(value, ['contractVersion', 'adapterId', 'adapterVersion', 'supportedStateVersions', 'rootOnly', 'cameraSource', 'needsDepth', 'parameterEquals', 'clock', 'qualities'], 'contract');
  if (value.contractVersion !== 1 || value.adapterId !== 'builtin-scene' || value.adapterVersion !== 1 || value.rootOnly !== true || value.cameraSource !== 'registry' || value.needsDepth !== true) throw new Error('Unsupported composition adapter');
  if (!Array.isArray(value.supportedStateVersions) || !value.supportedStateVersions.length || value.supportedStateVersions.length > 16 || new Set(value.supportedStateVersions).size !== value.supportedStateVersions.length || value.supportedStateVersions.some(version => !Number.isInteger(version) || version < 1 || version > input.stateVersion)) throw new Error('Invalid composition state versions');
  if (!value.parameterEquals || typeof value.parameterEquals !== 'object' || Array.isArray(value.parameterEquals)) throw new Error('Invalid composition predicates');
  for (const [key, expected] of Object.entries(value.parameterEquals)) {
    if (!Object.hasOwn(params, key)) throw new Error(`Unknown composition parameter: ${key}`);
    validateValue(key, params[key], expected);
  }
  record(value.clock, ['version', 'timeUnit', 'sampling', 'spectrumCapacity', 'inputBankLength', 'inputBankCount', 'inputBytes', 'neutral'], 'clock');
  const clock = value.clock;
  if (clock.version !== 1 || clock.timeUnit !== 'seconds' || clock.sampling !== 'absolute' || clock.neutral !== 'zero' || clock.spectrumCapacity !== 64 || clock.inputBankLength !== clock.spectrumCapacity + 11 || clock.inputBankCount !== 2 || clock.inputBytes !== clock.inputBankCount * clock.inputBankLength * Float64Array.BYTES_PER_ELEMENT) throw new Error('Unsupported composition clock');
  record(value.qualities, ['low'], 'qualities');
  if (typeof input.compositionResourcePlan !== 'function') throw new Error('Composition requires source resource planner');
  for (const [name, quality] of Object.entries(value.qualities)) {
    const profile = PROFILES[name];
    record(quality, [...Object.keys(profile), 'sourceResources', 'sourcePrimitives'], 'profile');
    for (const [key, expected] of Object.entries(profile)) if (quality[key] !== expected) throw new Error(`Composition profile differs from source: ${key}`);
    const resources = quality.sourceResources;
    record(resources, ['buffers', 'cpuPeakBytes', 'cpuRetainedBytes', 'bufferBytes', 'programs'], 'resources');
    if (!Array.isArray(resources.buffers) || !resources.buffers.length || resources.buffers.length > 32) throw new Error('Invalid composition buffers');
    const ids = new Set();
    for (const buffer of resources.buffers) {
      record(buffer, ['id', 'cpuPeakBytes', 'cpuRetainedBytes', 'bufferBytes'], 'buffer');
      if (typeof buffer.id !== 'string' || buffer.id.length > 64 || !/^[a-z][a-z0-9-]*$/.test(buffer.id) || ids.has(buffer.id)) throw new Error('Invalid composition buffer ID');
      ids.add(buffer.id);
      for (const key of ['cpuPeakBytes', 'cpuRetainedBytes', 'bufferBytes']) count(buffer[key], key);
      if (buffer.cpuRetainedBytes > buffer.cpuPeakBytes) throw new Error('Composition retained CPU exceeds peak');
    }
    for (const key of ['cpuPeakBytes', 'cpuRetainedBytes', 'bufferBytes']) {
      count(resources[key], key);
      if (resources[key] !== resources.buffers.reduce((sum, buffer) => sum + buffer[key], 0)) throw new Error(`Composition resource sum differs: ${key}`);
    }
    count(resources.programs, 'programs');
    if (!resources.programs) throw new Error('Composition requires source programs');
    record(quality.sourcePrimitives, ['drawCalls', 'points', 'triangles'], 'primitives');
    for (const [key, number] of Object.entries(quality.sourcePrimitives)) count(number, key);
    for (const [key, ceiling] of [['drawCalls', profile.drawCalls], ['points', profile.particles], ['triangles', profile.triangles]]) if (quality.sourcePrimitives[key] > ceiling) throw new Error(`Composition exceeds source ${key}`);
    const source = input.compositionResourcePlan({ quality: profile });
    for (const key of ['cpuPeakBytes', 'cpuRetainedBytes', 'bufferBytes', 'programs', 'buffers']) if (JSON.stringify(resources[key]) !== JSON.stringify(source[key])) throw new Error(`Composition resource differs from source: ${key}`);
    if (JSON.stringify(quality.sourcePrimitives) !== JSON.stringify(source.primitives)) throw new Error('Composition primitives differ from source');
  }
  return value;
}
export function createRegistry() {
  const definitions = new Map();
  const aliases = new Map();
  function resolve(id) { return definitions.has(id) ? id : aliases.get(id); }
  function get(id) {
    const definition = definitions.get(resolve(id));
    if (!definition) throw new Error(`Unavailable Three.js scene: ${id}`);
    return definition;
  }
  function register(input) {
    if (!input || input.apiVersion !== API_VERSION) throw new Error('Incompatible scene API version');
    if (!/^[a-z][a-z0-9-]*$/.test(input.id || '') || /anime-svg/.test(input.id)) throw new Error('Invalid scene ID');
    if (!Number.isInteger(input.stateVersion) || input.stateVersion < 1) throw new Error('Invalid state version');
    if (typeof input.create !== 'function') throw new Error('Missing scene factory');
    if (input.aliases !== undefined && !Array.isArray(input.aliases)) throw new Error('Scene aliases must be an array');
    for (const key of ['camera', 'capabilities', 'quality']) if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key])) throw new Error(`Invalid scene ${key}`);
    const camera = input.camera;
    for (const key of ['theta','phi','radius','fov','minRadius','maxRadius']) if (camera[key] !== undefined && !Number.isFinite(camera[key])) throw new Error(`Invalid camera ${key}`);
    if (camera.radius !== undefined && camera.radius <= 0 || camera.minRadius !== undefined && camera.minRadius <= 0 || camera.maxRadius !== undefined && camera.maxRadius <= 0 || camera.minRadius !== undefined && camera.maxRadius !== undefined && camera.minRadius > camera.maxRadius) throw new Error('Invalid camera radius bounds');
    if (camera.radius !== undefined && (camera.minRadius !== undefined && camera.radius < camera.minRadius || camera.maxRadius !== undefined && camera.radius > camera.maxRadius)) throw new Error('Default camera outside radius bounds');
    if (camera.fov !== undefined && (camera.fov <= 0 || camera.fov >= 180)) throw new Error('Invalid camera FOV');
    for (const key of ['lookAt','position']) if (camera[key] !== undefined && (!Array.isArray(camera[key]) || camera[key].length !== 3 || !camera[key].every(Number.isFinite))) throw new Error(`Invalid camera ${key}`);
    if (camera.fit && (!Number.isFinite(camera.fit.halfWidth) || !Number.isFinite(camera.fit.halfHeight) || camera.fit.halfWidth <= 0 || camera.fit.halfHeight <= 0)) throw new Error('Invalid camera framing bounds');
    for (const key of ['label', 'category', 'preview']) if (typeof input[key] !== 'string' || !input[key]) throw new Error(`Missing scene ${key}`);
    if (!input.preview.startsWith('/') || /(?:\.\.|https?:)/.test(input.preview)) throw new Error('Preview must be a local absolute asset path');
    const names = [input.id, ...(input.aliases || [])];
    if (new Set(names).size !== names.length) throw new Error('Duplicate scene alias');
    for (const name of names) {
      if (typeof name !== 'string' || !name || /anime-svg/.test(name)) throw new Error('Invalid scene alias');
      if (definitions.has(name) || aliases.has(name)) throw new Error(`Duplicate scene ID or alias: ${name}`);
    }
    const params = clone(input.params || {});
    for (const [key, spec] of Object.entries(params)) {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(key) || ['constructor','prototype'].includes(key)) throw new Error(`Invalid parameter key: ${key}`);
      if (!spec || !TYPES.has(spec.type)) throw new Error(`Invalid parameter specification: ${key}`);
      if (spec.type === 'number' && (!Number.isFinite(spec.min) || !Number.isFinite(spec.max) || spec.max < spec.min || (spec.step !== undefined && !(spec.step > 0)))) throw new Error(`Invalid parameter range: ${key}`);
      if (spec.type === 'select' && (!Array.isArray(spec.options) || !spec.options.length)) throw new Error(`Missing parameter options: ${key}`);
      if (spec.type === 'select') {
        const values = spec.options.map(option => option && typeof option === 'object' ? option.value : option);
        if (values.some(value => !['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) || new Set(values).size !== values.length) throw new Error(`Invalid parameter options: ${key}`);
      }
      if (spec.type === 'string' && spec.maxLength !== undefined && (!Number.isInteger(spec.maxLength) || spec.maxLength < 1 || spec.maxLength > 4096)) throw new Error(`Invalid text bound: ${key}`);
      validateValue(key, spec, spec.default);
    }
    if (input.migrateState !== undefined && typeof input.migrateState !== 'function') throw new Error('Invalid state migration');
    if (input.resourcePlan !== undefined && typeof input.resourcePlan !== 'function') throw new Error('Invalid resource plan');
    if (input.compositionResourcePlan !== undefined && typeof input.compositionResourcePlan !== 'function') throw new Error('Invalid composition resource plan');
    const composition = validateComposition(input, params);
    const metadata = freeze({ apiVersion: API_VERSION, id: input.id, stateVersion: input.stateVersion,
      label: input.label, category: input.category, preview: input.preview, aliases: names.slice(1), params,
      camera: clone(input.camera || {}), capabilities: clone(input.capabilities || {}), quality: clone(input.quality || {}),
      ...(composition ? { composition } : {}) });
    const definition = Object.freeze({ ...metadata, create: input.create, resourcePlan: input.resourcePlan,
      compositionResourcePlan: input.compositionResourcePlan, migrateState: input.migrateState, metadata });
    definitions.set(input.id, definition);
    names.slice(1).forEach(name => aliases.set(name, input.id));
    return metadata;
  }
  function validateParams(id, patch, base) {
    const def = get(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Parameters must be an object');
    const result = {};
    for (const key of Object.keys(patch)) if (!Object.hasOwn(def.params, key)) throw new Error(`Unknown parameter: ${key}`);
    for (const [key, spec] of Object.entries(def.params)) {
      const value = Object.hasOwn(patch, key) ? patch[key] : base && Object.hasOwn(base, key) ? base[key] : spec.default;
      result[key] = validateValue(key, spec, value);
    }
    return freeze(result);
  }
  function normalizeState(id, state = {}) {
    const def = get(id);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid scene state');
    let value = clone(state);
    const version = value.stateVersion === undefined ? def.stateVersion : value.stateVersion;
    if (!Number.isInteger(version) || version < 1 || version > def.stateVersion) throw new Error('Unsupported scene state version');
    if (version < def.stateVersion) {
      if (!def.migrateState) throw new Error('Scene state migration unavailable');
      value = def.migrateState(value, version, def.stateVersion);
      if (!value || value.stateVersion !== def.stateVersion) throw new Error('Migration did not produce current scene state');
    }
    const params = validateParams(def.id, value.params === undefined ? {} : value.params);
    return freeze({ id: def.id, stateVersion: def.stateVersion, params });
  }
  function compositionState(id, state, quality = 'low') {
    const def = get(id), normalized = normalizeState(id, state), contract = def.composition;
    if (!contract) throw new Error(`Composition adapter unavailable: ${def.id}`);
    if (!contract.supportedStateVersions.includes(normalized.stateVersion)) throw new Error(`Composition state version unavailable: ${def.id}`);
    const profile = Object.hasOwn(contract.qualities, quality) ? contract.qualities[quality] : null;
    if (!profile) throw new Error(`Composition quality unavailable: ${quality}`);
    for (const [key, expected] of Object.entries(contract.parameterEquals)) if (normalized.params[key] !== expected) throw new Error(`Composition parameter unavailable: ${def.id}.${key}`);
    return freeze({ ...normalized, composition: contract, profile });
  }
  return Object.freeze({ register, get, resolve, validateParams, normalizeState,
    compositionState,
    catalog: () => Object.freeze([...definitions.values()].map(def => def.metadata)) });
}
