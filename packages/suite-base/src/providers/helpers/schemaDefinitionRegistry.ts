// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  RegisteredSchemaDefinition,
  RegisteredSchemaDefinitionSource,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";

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

function sourceIdentityKey(source: RegisteredSchemaDefinitionSource): string {
  return [source.extensionNamespace ?? "", source.extensionId ?? "", source.label ?? ""].join("\n");
}

function mergeSchemaSources(
  a: readonly RegisteredSchemaDefinitionSource[],
  b: readonly RegisteredSchemaDefinitionSource[],
): RegisteredSchemaDefinitionSource[] {
  const merged = [...a, ...b];
  const deduped = new Map(merged.map((source) => [sourceIdentityKey(source), source]));
  return Array.from(deduped.values());
}

function schemaDefinitionsEqual(a: RegisteredSchemaDefinition, b: RegisteredSchemaDefinition): boolean {
  return a.name === b.name && a.encoding === b.encoding && schemasHaveSameData(a.data, b.data);
}

function dedupeSchemaDefinitions(
  schemas: readonly RegisteredSchemaDefinition[],
): RegisteredSchemaDefinition[] {
  const deduped: RegisteredSchemaDefinition[] = [];
  for (const schema of schemas) {
    const existingIndex = deduped.findIndex((existing) => schemaDefinitionsEqual(existing, schema));
    if (existingIndex >= 0) {
      const existing = deduped[existingIndex]!;
      deduped[existingIndex] = mergeEquivalentSchemaDefinitions(existing, schema);
    } else {
      deduped.push(schema);
    }
  }
  return deduped;
}

function mergeEquivalentSchemaDefinitions(
  existing: RegisteredSchemaDefinition,
  incoming: RegisteredSchemaDefinition,
): RegisteredSchemaDefinition {
  const mergedSources = mergeSchemaSources(
    existing.sources,
    incoming.sources,
  );
  return {
    ...existing,
    sources: mergedSources,
  };
}

export function mergeSchemaDefinitions(
  existing: Map<string, readonly RegisteredSchemaDefinition[]>,
  incoming: readonly RegisteredSchemaDefinition[],
): Map<string, readonly RegisteredSchemaDefinition[]> {
  const updated = new Map(existing);

  for (const schema of incoming) {
    const key = schemaDefinitionKey(schema.name, schema.encoding);
    const current = updated.get(key) ?? [];
    const equivalentIndex = current.findIndex((variant) => schemaDefinitionsEqual(variant, schema));
    if (equivalentIndex >= 0) {
      const equivalent = current[equivalentIndex]!;
      const next = [...current];
      next[equivalentIndex] = mergeEquivalentSchemaDefinitions(equivalent, schema);
      updated.set(key, next);
      continue;
    }

    if (current.length === 0) {
      updated.set(key, [schema]);
      continue;
    }

    updated.set(key, dedupeSchemaDefinitions([...current, schema]));
  }

  return updated;
}

export function removeSchemaDefinitionSource(
  schema: RegisteredSchemaDefinition,
  extensionNamespace: RegisteredSchemaDefinitionSource["extensionNamespace"],
  extensionId: string,
): RegisteredSchemaDefinition | undefined {
  const remainingSources = schema.sources.filter(
    (source) =>
      source.extensionId !== extensionId || source.extensionNamespace !== extensionNamespace,
  );
  if (remainingSources.length === 0) {
    return undefined;
  }

  return {
    ...schema,
    sources: remainingSources,
  };
}
