// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { satisfies, valid, validRange } from "semver";

type RequiredContractLike = {
  contractId: string;
  contractVersionRange: string;
  schemaHash?: string;
};

type ProvidedContractLike = {
  contractId: string;
  contractVersion: string;
  schemaHash?: string;
};

export function isRequiredContractLike(value: unknown): value is RequiredContractLike {
  if (typeof value !== "object" || value == undefined) {
    return false;
  }
  const maybe = value as Partial<RequiredContractLike>;
  return typeof maybe.contractId === "string" && typeof maybe.contractVersionRange === "string";
}

export function isProvidedContractLike(value: unknown): value is ProvidedContractLike {
  if (typeof value !== "object" || value == undefined) {
    return false;
  }
  const maybe = value as Partial<ProvidedContractLike>;
  return typeof maybe.contractId === "string" && typeof maybe.contractVersion === "string";
}

export function isRequiredContractSatisfied(
  providedContractValue: unknown,
  requiredContractValue: unknown,
): boolean {
  if (!isProvidedContractLike(providedContractValue)) {
    return false;
  }
  if (!isRequiredContractLike(requiredContractValue)) {
    return false;
  }
  const providedContract = providedContractValue;
  const requiredContract = requiredContractValue;

  if (providedContract.contractId !== requiredContract.contractId) {
    return false;
  }
  if (
    !valid(providedContract.contractVersion) ||
    !validRange(requiredContract.contractVersionRange)
  ) {
    return providedContract.contractVersion === requiredContract.contractVersionRange;
  }
  if (!satisfies(providedContract.contractVersion, requiredContract.contractVersionRange)) {
    return false;
  }
  if (
    requiredContract.schemaHash != undefined &&
    providedContract.schemaHash !== requiredContract.schemaHash
  ) {
    return false;
  }
  return true;
}
