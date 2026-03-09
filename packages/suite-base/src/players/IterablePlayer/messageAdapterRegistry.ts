// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { RegisterMessageContractDecoderArgs } from "@lichtblick/suite";

let registeredMessageContractDecoders: readonly RegisterMessageContractDecoderArgs<unknown>[] = [];

export function setRegisteredMessageContractDecoders(
  decoders: readonly RegisterMessageContractDecoderArgs<unknown>[],
): void {
  registeredMessageContractDecoders = decoders;
}

export function getRegisteredMessageContractDecoders(): readonly RegisterMessageContractDecoderArgs<unknown>[] {
  return registeredMessageContractDecoders;
}

/**
 * @deprecated Use setRegisteredMessageContractDecoders.
 */
export function setRegisteredMessageAdapters(
  adapters: readonly RegisterMessageContractDecoderArgs<unknown>[],
): void {
  setRegisteredMessageContractDecoders(adapters);
}

/**
 * @deprecated Use getRegisteredMessageContractDecoders.
 */
export function getRegisteredMessageAdapters(): readonly RegisterMessageContractDecoderArgs<unknown>[] {
  return getRegisteredMessageContractDecoders();
}
