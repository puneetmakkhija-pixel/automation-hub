// Tiny declarative mapping used by vendor specs, so a new vendor is configuration, not code.
//
//   render(template, ctx)   fills "{{customer.mobile}}" placeholders in a request template
//   extract(spec, source)   builds a normalised object from a vendor response
//
// extract() spec forms:
//   "data.score"                                   path, value as-is
//   { path, type, map, default, divideBy }         path with coercion
//        type: 'number' | 'boolean' | 'string'; map: { vendorValue: normalisedValue }
//        divideBy: e.g. 100 to turn paise into rupees
//   { const: 5 }                                   fixed value
//   { array: { path, item: { field: spec, ... } } }   map a list
//   { field: spec, ... }                           nested object
// A missing value becomes `default` if given, else null: absence is never invented.

export function getPath(obj, path) {
  if (path === null || path === undefined || path === '') return undefined;
  return String(path).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

const WHOLE = /^\{\{\s*([\w.]+)\s*\}\}$/;
const INLINE = /\{\{\s*([\w.]+)\s*\}\}/g;

export function render(template, ctx) {
  if (typeof template === 'string') {
    const whole = template.match(WHOLE);
    if (whole) {
      const v = getPath(ctx, whole[1]);
      return v === undefined ? null : v; // keeps numbers and booleans typed
    }
    return template.replace(INLINE, (_, p) => {
      const v = getPath(ctx, p);
      return v === undefined || v === null ? '' : String(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => render(t, ctx));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, render(v, ctx)]));
  }
  return template;
}

function coerce(v, type) {
  if (type === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return ['true', 'y', 'yes', '1'].includes(String(v).toLowerCase());
  }
  if (type === 'string') return String(v);
  return v;
}

function extractObject(specObj, src) {
  return Object.fromEntries(Object.entries(specObj).map(([k, s]) => [k, extract(s, src)]));
}

export function extract(spec, src) {
  if (typeof spec === 'string') {
    const v = getPath(src, spec);
    return v === undefined ? null : v;
  }
  if (!spec || typeof spec !== 'object') return null;
  if ('const' in spec) return spec.const;
  if (spec.array) {
    const list = getPath(src, spec.array.path);
    return Array.isArray(list) ? list.map((it) => extractObject(spec.array.item, it)) : [];
  }
  if ('path' in spec) {
    const fallback = spec.default === undefined ? null : spec.default;
    let v = getPath(src, spec.path);
    if (v === undefined || v === null) return fallback;
    if (spec.map) {
      const key = String(v);
      return Object.prototype.hasOwnProperty.call(spec.map, key) ? spec.map[key] : fallback;
    }
    v = coerce(v, spec.type);
    if (typeof v === 'number' && spec.divideBy) v /= spec.divideBy;
    return v;
  }
  return extractObject(spec, src);
}
