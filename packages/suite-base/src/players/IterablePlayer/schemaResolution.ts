// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import Logger from "@lichtblick/log";
import { parseChannel, SchemaDefinition } from "@lichtblick/mcap-support";
import { Initialization } from "@lichtblick/suite-base/players/IterablePlayer/IIterableSource";

const log = Logger.getLogger(__filename);

export type SchemaDefinitionWithSource = SchemaDefinition & {
  extensionId?: string;
  extensionNamespace?: string;
  conflictingSchemaDefinitions?: Array<SchemaDefinitionWithSource>;
};

type ResolveDeserializerForTopicArgs = {
  topic: string;
  messageEncoding?: string;
  schemaName?: string;
  schemaData?: Uint8Array;
  schemaEncoding?: string;
  registeredSchemaDefinitionsByName?: Map<string, SchemaDefinition>;
};

export type ResolveDeserializerForTopicResult = {
  deserialize: (data: ArrayBufferView) => unknown;
  alerts: Initialization["alerts"];
};

function schemaDefinitionKey(name: string, encoding: string): string {
  return `${name}\n${encoding}`;
}

function preferredSchemaEncodings(messageEncoding: string): string[] {
  if (messageEncoding === "json") {
    return ["jsonschema"];
  }
  if (messageEncoding === "flatbuffer") {
    return ["flatbuffer"];
  }
  if (messageEncoding === "protobuf") {
    return ["protobuf"];
  }
  if (messageEncoding === "ros1") {
    return ["ros1msg"];
  }
  if (messageEncoding === "cdr") {
    return ["ros2msg", "ros2idl", "omgidl"];
  }
  return [];
}

function describeSchemaSource(schema: SchemaDefinition): string {
  const schemaWithSource = schema as SchemaDefinitionWithSource;
  const id = schemaWithSource.extensionId;
  const namespace = schemaWithSource.extensionNamespace;

  if (id != undefined && namespace != undefined) {
    return `${namespace}:${id}`;
  }
  if (id != undefined) {
    return id;
  }
  if (namespace != undefined) {
    return namespace;
  }
  return "unknown";
}

function namespacePriority(namespace: string | undefined): number {
  if (namespace === "local") {
    return 0;
  }
  if (namespace === "org") {
    return 1;
  }
  return 2;
}

function compareSchemaCandidates(
  a: SchemaDefinitionWithSource,
  b: SchemaDefinitionWithSource,
): number {
  const namespaceOrder =
    namespacePriority(a.extensionNamespace) - namespacePriority(b.extensionNamespace);
  if (namespaceOrder !== 0) {
    return namespaceOrder;
  }

  const idOrder = (a.extensionId ?? "").localeCompare(b.extensionId ?? "");
  if (idOrder !== 0) {
    return idOrder;
  }

  const lengthOrder = a.data.byteLength - b.data.byteLength;
  if (lengthOrder !== 0) {
    return lengthOrder;
  }

  for (let i = 0; i < a.data.byteLength; i++) {
    const byteOrder = (a.data[i] ?? 0) - (b.data[i] ?? 0);
    if (byteOrder !== 0) {
      return byteOrder;
    }
  }
  return 0;
}

function expandAndSortSchemaCandidates(
  schema: SchemaDefinitionWithSource,
): SchemaDefinitionWithSource[] {
  return [schema, ...(schema.conflictingSchemaDefinitions ?? [])].sort(compareSchemaCandidates);
}

export function resolveDeserializerForTopic(
  args: ResolveDeserializerForTopicArgs,
): ResolveDeserializerForTopicResult {
  const { topic, messageEncoding, schemaName, schemaData, schemaEncoding, registeredSchemaDefinitionsByName } = args;
  const alerts: Initialization["alerts"] = [];

  if (messageEncoding == undefined) {
    throw new Error(`Unspecified message encoding for topic ${topic}`);
  }

  let usedRegistrySchema = false;
  let selectedRegistrySchema: SchemaDefinitionWithSource | undefined;
  let selectedRegistryCandidates: SchemaDefinitionWithSource[] = [];

  try {
    let candidateSchemas: SchemaDefinitionWithSource[] = [];

    if (schemaName != undefined) {
      if (schemaEncoding != undefined) {
        const schema = registeredSchemaDefinitionsByName?.get(schemaDefinitionKey(schemaName, schemaEncoding));
        if (schema != undefined) {
          candidateSchemas = expandAndSortSchemaCandidates(schema as SchemaDefinitionWithSource);
        }
      } else {
        for (const preferredEncoding of preferredSchemaEncodings(messageEncoding)) {
          const schema = registeredSchemaDefinitionsByName?.get(schemaDefinitionKey(schemaName, preferredEncoding));
          if (schema != undefined) {
            candidateSchemas = expandAndSortSchemaCandidates(schema as SchemaDefinitionWithSource);
            break;
          }
        }

        if (candidateSchemas.length === 0) {
          const allSchemasForName =
            registeredSchemaDefinitionsByName == undefined
              ? []
              : Array.from(registeredSchemaDefinitionsByName.values()).filter(
                  (registeredSchema) => registeredSchema.name === schemaName,
                );
          if (allSchemasForName.length === 1) {
            candidateSchemas = [allSchemasForName[0]! as SchemaDefinitionWithSource];
          }
        }
      }

      if (candidateSchemas.length > 0) {
        selectedRegistryCandidates = candidateSchemas;
        for (const candidateSchema of candidateSchemas) {
          try {
            const { deserialize } = parseChannel({
              messageEncoding,
              schema: {
                name: schemaName,
                encoding: candidateSchema.encoding,
                data: candidateSchema.data,
              },
            });
            selectedRegistrySchema = candidateSchema;
            selectedRegistryCandidates = candidateSchemas;
            usedRegistrySchema = true;
            return {
              deserialize,
              alerts: [
                {
                  severity: "info",
                  message: `Using registered schema definition for ${schemaName} (${selectedRegistrySchema.encoding}) from ${describeSchemaSource(
                    selectedRegistrySchema,
                  )}.`,
                },
                ...(selectedRegistryCandidates.length > 1
                  ? [
                      {
                        severity: "warn" as const,
                        message: `Using registered schema definition from ${describeSchemaSource(selectedRegistrySchema)}.`,
                        error: Error(
                          `Multiple registered schema definitions found for ${schemaName} (${selectedRegistrySchema.encoding}).`,
                        ),
                      },
                    ]
                  : []),
              ],
            };
          } catch {
            // Try the next registered schema candidate.
          }
        }
        if (!usedRegistrySchema) {
          throw new Error(`No compatible registered schema definition found for ${schemaName}.`);
        }
      } else if (registeredSchemaDefinitionsByName != undefined) {
        const schemaVariants = Array.from(registeredSchemaDefinitionsByName.values()).filter(
          (registeredSchema) => registeredSchema.name === schemaName,
        );
        const registeredSchemaVariants = Array.from(
          new Set(schemaVariants.map((registeredSchema) => registeredSchema.encoding)),
        );
        log.info("No registered schema definition found for topic schema", {
          topic,
          schemaName,
          registeredSchemaVariants,
        });
      }
    }

    const fallbackSchema =
      schemaName != undefined && schemaData != undefined && schemaEncoding != undefined
        ? {
            name: schemaName,
            encoding: schemaEncoding,
            data: schemaData,
          }
        : undefined;

    const { deserialize } = parseChannel({
      messageEncoding,
      schema: fallbackSchema,
    });

    if (schemaName != undefined && (schemaData != undefined || schemaEncoding != undefined)) {
      log.info("Using MCAP schema definition for topic", {
        topic,
        schemaName,
        schemaEncoding,
        hasSchemaData: schemaData != undefined,
      });
    }

    return { deserialize, alerts };
  } catch (error) {
    if (schemaName != undefined && selectedRegistryCandidates.length > 0) {
      const mcapSchema =
        schemaData != undefined && schemaEncoding != undefined
          ? {
              name: schemaName,
              encoding: schemaEncoding,
              data: schemaData,
            }
          : undefined;
      if (mcapSchema != undefined) {
        try {
          const { deserialize } = parseChannel({
            messageEncoding,
            schema: mcapSchema,
          });
          log.warn("Failed to use registered schema definition for topic, trying MCAP schema", {
            topic,
            schemaName,
            mcapSchemaEncoding: schemaEncoding,
          });
          alerts.push({
            severity: "warn",
            message: `Falling back to MCAP schema definition.`,
            error: Error(`Failed to use registered schema definition for ${schemaName}.`),
          });
          return { deserialize, alerts };
        } catch {
          // Continue to generic error handling below.
        }
      }
    }
    throw error;
  }
}
