// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { RegisteredSchemaDefinition } from "@lichtblick/suite-base/context/ExtensionCatalogContext";

export function schemaDefinitionKey(name: string, encoding: string): string {
  return `${name}\n${encoding}`;
}

function schemasHaveSameData(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) {
    return true;
  }
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function schemaDataFingerprint(data: Uint8Array): number {
  let hash = 2166136261;
  for (let i = 0; i < data.byteLength; i++) {
    hash ^= data[i]!;
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function schemaDefinitionIdentityKey(schema: RegisteredSchemaDefinition): string {
  return [
    schema.name,
    schema.encoding,
    schema.data.byteLength.toString(),
    schemaDataFingerprint(schema.data).toString(),
  ].join("\n");
}

function schemaDefinitionsEqual(a: RegisteredSchemaDefinition, b: RegisteredSchemaDefinition): boolean {
  return a.name === b.name && a.encoding === b.encoding && schemasHaveSameData(a.data, b.data);
}

export function mergeSchemaDefinitions(
  existing: Map<string, readonly RegisteredSchemaDefinition[]>,
  incoming: readonly RegisteredSchemaDefinition[],
): Map<string, readonly RegisteredSchemaDefinition[]> {
  const updated = new Map(existing);

  for (const schema of incoming) {
    const key = schemaDefinitionKey(schema.name, schema.encoding);
    const current = updated.get(key) ?? [];
    if (current.some((variant) => schemaDefinitionsEqual(variant, schema))) {
      continue;
    }

    if (current.length === 0) {
      updated.set(key, [schema]);
      continue;
    }

    const next = new Map(
      [...current, schema].map((candidate) => [schemaDefinitionIdentityKey(candidate), candidate]),
    );
    updated.set(key, Array.from(next.values()));
  }

  return updated;
}
