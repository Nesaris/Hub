// Validateur JSON Schema (sous-ensemble 2020-12 utilisé par hub-extension.schema.json).
export function createValidator(rootSchema) {
  const resolve = ref => {
    if (!ref.startsWith('#/')) throw new Error('$ref non supporté : ' + ref);
    return ref.slice(2).split('/').reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema);
  };
  const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  const typeOk = (t, v) => { const a = typeOf(v); return t === a || (t === 'number' && a === 'integer'); };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function check(schema, v, p, errors) {
    if (schema === true || schema == null) return;
    if (schema === false) { errors.push({ path: p, message: 'valeur interdite' }); return; }
    if (schema.$ref) check(resolve(schema.$ref), v, p, errors);
    if (schema.type) {
      const types = [].concat(schema.type);
      if (!types.some(t => typeOk(t, v))) { errors.push({ path: p, message: `type attendu ${types.join('|')}` }); return; }
    }
    if ('const' in schema && !eq(schema.const, v)) errors.push({ path: p, message: `doit valoir ${JSON.stringify(schema.const)}` });
    if (schema.enum && !schema.enum.some(e => eq(e, v))) errors.push({ path: p, message: `valeur hors liste (${schema.enum.join(', ')})` });
    if (typeof v === 'string') {
      if (schema.minLength != null && v.length < schema.minLength) errors.push({ path: p, message: `au moins ${schema.minLength} caractères` });
      if (schema.maxLength != null && v.length > schema.maxLength) errors.push({ path: p, message: `au plus ${schema.maxLength} caractères` });
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) errors.push({ path: p, message: `format invalide (${schema.pattern})` });
    }
    if (typeof v === 'number') {
      if (schema.minimum != null && v < schema.minimum) errors.push({ path: p, message: `minimum ${schema.minimum}` });
      if (schema.maximum != null && v > schema.maximum) errors.push({ path: p, message: `maximum ${schema.maximum}` });
    }
    if (Array.isArray(v)) {
      if (schema.minItems != null && v.length < schema.minItems) errors.push({ path: p, message: `au moins ${schema.minItems} éléments` });
      if (schema.maxItems != null && v.length > schema.maxItems) errors.push({ path: p, message: `au plus ${schema.maxItems} éléments` });
      if (schema.uniqueItems && new Set(v.map(x => JSON.stringify(x))).size !== v.length) errors.push({ path: p, message: 'éléments en double' });
      if (schema.items) v.forEach((x, i) => check(schema.items, x, `${p}[${i}]`, errors));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const r of schema.required || []) if (!(r in v)) errors.push({ path: p, message: `champ requis manquant : ${r}` });
      const props = schema.properties || {};
      for (const [k, x] of Object.entries(v)) {
        if (props[k]) check(props[k], x, `${p}.${k}`, errors);
        else if (schema.additionalProperties === false) errors.push({ path: p, message: `champ inconnu : ${k}` });
        else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, x, `${p}.${k}`, errors);
      }
    }
    if (schema.allOf) for (const s of schema.allOf) check(s, v, p, errors);
    if (schema.anyOf && !schema.anyOf.some(s => { const e = []; check(s, v, p, e); return !e.length; })) errors.push({ path: p, message: 'ne correspond à aucune variante' });
    if (schema.oneOf) {
      const results = schema.oneOf.map(s => { const e = []; check(s, v, p, e); return e; });
      const n = results.filter(e => !e.length).length;
      if (n !== 1) {
        if (n === 0) { const best = results.reduce((a, b) => (b.length < a.length ? b : a)); errors.push(...best); }
        else errors.push({ path: p, message: 'correspond à plusieurs variantes' });
      }
    }
    if (schema.if) {
      const e = []; check(schema.if, v, p, e);
      if (!e.length && schema.then) check(schema.then, v, p, errors);
      if (e.length && schema.else) check(schema.else, v, p, errors);
    }
  }
  return value => { const errors = []; check(rootSchema, value, '$', errors); return { valid: !errors.length, errors }; };
}
