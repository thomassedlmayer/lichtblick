// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import Logger from "@lichtblick/log";

const log = Logger.getLogger(__filename);

type ChannelMetaLike = {
  topic?: string;
  schemaName?: string;
};

type MessageContractDecoderCandidate = {
  id: string;
  priority?: number;
  sourceSchemas: readonly string[];
  match(meta: Readonly<ChannelMetaLike>): boolean;
  deserialize(bytes: ArrayBufferView, meta: Readonly<ChannelMetaLike>): unknown;
  providedContract?: unknown;
  toJson?: (msg: unknown, meta: Readonly<ChannelMetaLike>) => unknown;
  validateInput?: (msg: unknown) => boolean;
};

function isMessageContractDecoderCandidate(
  value: unknown,
): value is MessageContractDecoderCandidate {
  if (typeof value !== "object" || value == undefined) {
    return false;
  }
  const maybe = value as Partial<MessageContractDecoderCandidate>;
  return (
    typeof maybe.id === "string" &&
    Array.isArray(maybe.sourceSchemas) &&
    typeof maybe.match === "function" &&
    typeof maybe.deserialize === "function"
  );
}

export function resolveMessageContractDecoder(
  adapters: readonly unknown[],
  meta: Readonly<ChannelMetaLike>,
): MessageContractDecoderCandidate | undefined {
  const sourceSchemaName = typeof meta.schemaName === "string" ? meta.schemaName : "";
  const topicName = typeof meta.topic === "string" ? meta.topic : "<unknown-topic>";

  const matches = adapters.filter(isMessageContractDecoderCandidate).filter((adapter) => {
    if (adapter.sourceSchemas.length > 0 && !adapter.sourceSchemas.includes(sourceSchemaName)) {
      return false;
    }
    return adapter.match(meta);
  });

  if (matches.length === 0) {
    return undefined;
  }

  const sorted = [...matches].sort((a, b) => {
    const priorityA = a.priority ?? 0;
    const priorityB = b.priority ?? 0;
    if (priorityA !== priorityB) {
      return priorityB - priorityA;
    }
    return a.id.localeCompare(b.id);
  });

  if (sorted.length > 1) {
    const schemaNameForLog = sourceSchemaName === "" ? "<unknown>" : sourceSchemaName;
    log.warn(
      `Multiple message adapters matched topic '${topicName}' schema '${schemaNameForLog}'. Selected '${sorted[0]?.id}' by deterministic priority/id ordering.`,
    );
  }
  return sorted[0];
}

/**
 * @deprecated Use resolveMessageContractDecoder.
 */
export const resolveMessageAdapter = resolveMessageContractDecoder;
