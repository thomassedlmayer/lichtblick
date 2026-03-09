// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import Logger from "@lichtblick/log";
import type { ChannelMeta, MessageAdapter } from "@lichtblick/suite";

const log = Logger.getLogger(__filename);

export function resolveMessageAdapter(
  adapters: readonly MessageAdapter<unknown>[],
  meta: Readonly<ChannelMeta>,
): MessageAdapter<unknown> | undefined {
  const matches = adapters.filter((adapter) => {
    if (adapter.sourceSchemas.length > 0 && !adapter.sourceSchemas.includes(meta.schemaName ?? "")) {
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
    log.warn(
      `Multiple message adapters matched topic '${meta.topic}' schema '${meta.schemaName ?? "<unknown>"}'. Selected '${sorted[0]?.id}' by deterministic priority/id ordering.`,
    );
  }
  return sorted[0];
}
