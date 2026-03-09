// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { MessageAdapter } from "@lichtblick/suite";

let registeredMessageAdapters: readonly MessageAdapter<unknown>[] = [];

export function setRegisteredMessageAdapters(adapters: readonly MessageAdapter<unknown>[]): void {
  registeredMessageAdapters = adapters;
}

export function getRegisteredMessageAdapters(): readonly MessageAdapter<unknown>[] {
  return registeredMessageAdapters;
}
