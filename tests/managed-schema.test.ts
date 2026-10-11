import { describe, it, expect } from 'vitest';
import schemaSource from '../managed_schema.json?raw';

// Chrome strictly validates storage.managed_schema files and REJECTS the
// extension if the schema uses constructs outside its JSON-Schema subset
// ("Invalid type for attribute ..." at load). Rules enforced here:
//   - top-level schema: type object, NO additionalProperties at all;
//   - every schema node has $ref or exactly one type;
//   - nested additionalProperties may exist only as a schema object,
//     never a boolean;
//   - only keywords the Chrome policy-schema parser knows are allowed.
// Ref: https://developer.chrome.com/docs/extensions/reference/manifest/storage

// Keywords recognized by Chrome's policy schema parser
// (components/policy/core/common/schema.cc). Booleans-as-schemas and
// draft-07+ keywords (const, allOf, default, etc.) are NOT supported.
const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'items', 'additionalProperties', 'patternProperties',
  'required', 'enum', 'pattern',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  '$ref', 'id', 'title', 'description', 'sensitive',
]);

const VALID_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);

function collectSchemaNodes(node: unknown, path: string, out: { node: Record<string, unknown>; path: string }[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  out.push({ node: obj, path });
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [prop, sub] of Object.entries(value)) {
        collectSchemaNodes(sub, `${path}.properties.${prop}`, out);
      }
    } else if ((key === 'items' || key === 'additionalProperties' || key === 'patternProperties') && value && typeof value === 'object' && !Array.isArray(value)) {
      if (key === 'patternProperties') {
        for (const [pattern, sub] of Object.entries(value)) {
          collectSchemaNodes(sub, `${path}.patternProperties.${pattern}`, out);
        }
      } else {
        collectSchemaNodes(value, `${path}.${key}`, out);
      }
    }
  }
}

const schema = JSON.parse(schemaSource) as Record<string, unknown>;
const nodes: { node: Record<string, unknown>; path: string }[] = [];
collectSchemaNodes(schema, '$', nodes);

describe('managed_schema.json — Chrome policy schema subset', () => {
  it('top-level is type object', () => {
    expect(schema.type).toBe('object');
  });

  it('top-level has NO additionalProperties (Chrome rejects it)', () => {
    expect('additionalProperties' in schema).toBe(false);
  });

  it('every schema node uses only Chrome-allowed keywords', () => {
    for (const { node, path } of nodes) {
      for (const key of Object.keys(node)) {
        expect(ALLOWED_SCHEMA_KEYWORDS.has(key), `${path}: keyword "${key}" not in Chrome policy schema subset`).toBe(true);
      }
    }
  });

  it('every schema node has $ref or exactly one valid type', () => {
    for (const { node, path } of nodes) {
      if ('$ref' in node) continue;
      expect(VALID_TYPES.has(node.type as string), `${path}: type "${String(node.type)}" invalid or missing`).toBe(true);
    }
  });

  it('additionalProperties, where allowed, is a schema object — never a boolean', () => {
    for (const { node, path } of nodes) {
      if ('additionalProperties' in node) {
        expect(typeof node.additionalProperties === 'object' && node.additionalProperties !== null,
          `${path}: additionalProperties must be a schema, got ${typeof node.additionalProperties}`).toBe(true);
      }
    }
  });

  it('declares the ingestKey policy as a string', () => {
    const props = schema.properties as Record<string, { type?: string }>;
    expect(props.ingestKey?.type).toBe('string');
  });
});
