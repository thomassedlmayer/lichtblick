// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { RegisteredSchemaDefinition } from "@lichtblick/suite-base/context/ExtensionCatalogContext";

import { mergeSchemaDefinitions, removeSchemaDefinitionSource } from "./schemaDefinitionRegistry";

describe("schemaDefinitionRegistry", () => {
  it("keeps identical schemas deduped while preserving all sources", () => {
    const schemaA: RegisteredSchemaDefinition = {
      name: "osi3.sensorview",
      encoding: "protobuf",
      data: new Uint8Array([1, 2, 3]),
      sources: [{ extensionNamespace: "local", extensionId: "ext-a" }],
    };
    const schemaB: RegisteredSchemaDefinition = {
      name: "osi3.sensorview",
      encoding: "protobuf",
      data: new Uint8Array([1, 2, 3]),
      sources: [{ extensionNamespace: "org", extensionId: "ext-b" }],
    };

    const merged = mergeSchemaDefinitions(new Map(), [schemaA, schemaB]);
    const definitions = merged.get("osi3.sensorview\nprotobuf");
    expect(definitions).toBeDefined();
    expect(definitions).toHaveLength(1);
    expect(definitions?.[0]?.sources).toEqual([
      { extensionNamespace: "local", extensionId: "ext-a" },
      { extensionNamespace: "org", extensionId: "ext-b" },
    ]);
  });

  it("removes only one source and keeps schema while other sources remain", () => {
    const schema: RegisteredSchemaDefinition = {
      name: "osi3.sensorview",
      encoding: "protobuf",
      data: new Uint8Array([1, 2, 3]),
      sources: [
        { extensionNamespace: "local", extensionId: "ext-a" },
        { extensionNamespace: "org", extensionId: "ext-b" },
      ],
    };

    const updated = removeSchemaDefinitionSource(schema, "ext-a");
    expect(updated).toBeDefined();
    expect(updated?.sources).toEqual([{ extensionNamespace: "org", extensionId: "ext-b" }]);
  });
});
