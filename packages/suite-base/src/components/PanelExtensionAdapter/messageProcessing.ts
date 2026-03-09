// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";
import { Opaque } from "ts-essentials";

import Logger from "@lichtblick/log";
import {
  Immutable,
  MessageEvent,
  RegisterMessageContractDecoderArgs,
  Subscription,
} from "@lichtblick/suite";
import type {
  MessageConverter,
  RegisteredMessageContractConverter,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import { GlobalVariables } from "@lichtblick/suite-base/hooks/useGlobalVariables";
import { Topic as PlayerTopic } from "@lichtblick/suite-base/players/types";

import { isRequiredContractLike, isRequiredContractSatisfied } from "./contractMatching";

// Branded string to ensure that users go through the `converterKey` function to compute a lookup key
type ConverterKey = Opaque<string, "ConverterKey">;

type ContractConverter = RegisteredMessageContractConverter;

type TopicSchemaConverterMap = Map<ConverterKey, MessageConverter[]>;
type TopicSchemaContractConverterMap = Map<ConverterKey, ContractConverter[]>;
type TopicJsonAdapterMap = Map<string, RegisterMessageContractDecoderArgs<unknown>>;

const log = Logger.getLogger(__filename);

// Create a string lookup key from a message event
//
// The string key uses a newline delimeter to avoid producting the same key for topic/schema name
// values that might concatenate to the same string. i.e. "topic" "schema" and "topics" "chema".
function converterKey(topic: string, schema: string): ConverterKey {
  return (topic + "\n" + schema) as ConverterKey;
}

/**
 * Convert message into convertedMessages using the keyed converters. Modifies
 * convertedMessages in place for efficiency.
 */
export function convertMessage(
  messageEvent: Immutable<MessageEvent>,
  converters: Immutable<TopicSchemaConverterMap>,
  convertedMessages: MessageEvent[],
  globalVariables?: Readonly<GlobalVariables>,
): void {
  const key = converterKey(messageEvent.topic, messageEvent.schemaName);
  const matchedConverters = converters.get(key);
  for (const converter of matchedConverters ?? []) {
    const convertedMessage = converter.converter(
      messageEvent.message,
      messageEvent,
      globalVariables,
    );
    // If the converter returns _undefined_ or _null_ the message is skipped
    if (convertedMessage == undefined) {
      continue;
    }
    convertedMessages.push({
      topic: messageEvent.topic,
      schemaName: converter.toSchemaName,
      receiveTime: messageEvent.receiveTime,
      message: convertedMessage,
      originalMessageEvent: messageEvent,
      sizeInBytes: messageEvent.sizeInBytes,
      topicConfig: messageEvent.topicConfig,
    });
  }
}

export function convertContractMessage(
  messageEvent: Immutable<MessageEvent>,
  converters: Immutable<TopicSchemaContractConverterMap>,
  convertedMessages: MessageEvent[],
  globalVariables?: Readonly<GlobalVariables>,
): void {
  const key = converterKey(messageEvent.topic, messageEvent.schemaName);
  const matchedConverters = converters.get(key);
  for (const converter of matchedConverters ?? []) {
    const convertedMessage = converter.convert(messageEvent.message, messageEvent, globalVariables);
    if (convertedMessage == undefined) {
      continue;
    }
    convertedMessages.push({
      topic: messageEvent.topic,
      schemaName: converter.toSchemaName,
      receiveTime: messageEvent.receiveTime,
      message: convertedMessage,
      originalMessageEvent: messageEvent,
      sizeInBytes: messageEvent.sizeInBytes,
      topicConfig: messageEvent.topicConfig,
    });
  }
}

export function projectMessageForJsonPanels(
  messageEvent: Immutable<MessageEvent>,
  adapterByTopic: Immutable<TopicJsonAdapterMap>,
  topicMetaByName: Immutable<Map<string, PlayerTopic>>,
): MessageEvent {
  const adapter = adapterByTopic.get(messageEvent.topic);
  if (adapter?.toJson == undefined) {
    return messageEvent;
  }
  const topicMeta = topicMetaByName.get(messageEvent.topic);
  const projected = adapter.toJson(messageEvent.message, {
    topic: messageEvent.topic,
    schemaName: topicMeta?.schemaName,
    messageEncoding: topicMeta?.messageEncoding,
    schemaEncoding: topicMeta?.schemaEncoding,
    schemaData: topicMeta?.schemaData,
  });
  return { ...messageEvent, message: projected };
}

/**
 * Returns a new map consisting of all items in `a` not present in `b`.
 */
export function mapDifference<K, V>(a: Map<K, V[]>, b: undefined | Map<K, V[]>): Map<K, V[]> {
  const result = new Map<K, V[]>();
  for (const [key, value] of a.entries()) {
    const newValues = _.difference(value, b?.get(key) ?? []);
    if (newValues.length > 0) {
      result.set(key, newValues);
    }
  }
  return result;
}

export type TopicSchemaConversions = {
  // Topics which we are subscribed without a conversion, these are topics we
  // want to receive the original message.
  unconvertedSubscriptionTopics: Set<string>;

  // When a subscription with a convertTo exists, we use this map to lookup a
  // converter which can produce the desired output message schema. The keys for
  // the map are `topic + input schema`.
  //
  // This allows the runtime message event handler logic which builds
  // currentFrame and allFrames to lookup whether the incoming message event has
  // converters to run by looking up the topic + schema of the message event in
  // this map.
  topicSchemaConverters: TopicSchemaConverterMap;
  topicSchemaContractConverters: TopicSchemaContractConverterMap;
  topicJsonAdapters: TopicJsonAdapterMap;
};

/**
 * Builds a set of topics we can render without conversion and a map of
 * converterKey -> converter arguments we use to produce converted messages.
 *
 * This will be memoized for performance so the inputs should be stable.
 */
export function collateTopicSchemaConversions(
  subscriptions: readonly Subscription[],
  sortedTopics: readonly PlayerTopic[],
  messageConverters: undefined | readonly MessageConverter[],
  messageContractDecoders?: readonly RegisterMessageContractDecoderArgs<unknown>[],
  messageContractConverters?: readonly ContractConverter[],
): TopicSchemaConversions {
  const topicSchemaConverters: TopicSchemaConverterMap = new Map();
  const topicSchemaContractConverters: TopicSchemaContractConverterMap = new Map();
  const topicJsonAdapters: TopicJsonAdapterMap = new Map();
  const unconvertedSubscriptionTopics = new Set<string>();
  const adapterByContractId = new Map(
    (messageContractDecoders ?? [])
      .filter((adapter) => adapter.providedContract != undefined)
      .map((adapter) => [adapter.providedContract.contractId, adapter] as const),
  );

  // Bin the subscriptions into two sets: those which want a conversion and those that do not.
  //
  // For the subscriptions that want a conversion, if the topic schemaName matches the requested
  // convertTo, then we don't need to do a conversion.
  for (const subscription of subscriptions) {
    const subscriberTopic = sortedTopics.find((topic) => topic.name === subscription.topic);
    if (!subscriberTopic) {
      continue;
    }

    if (isRequiredContractLike(subscription.requiresContract)) {
      if (
        !isRequiredContractSatisfied(
          subscriberTopic.providedContract,
          subscription.requiresContract,
        )
      ) {
        log.warn(
          `Unmet required contract for topic '${subscription.topic}'. Required ${subscription.requiresContract.contractId}@${subscription.requiresContract.contractVersionRange}.`,
        );
        continue;
      }

      if (!subscription.convertTo) {
        unconvertedSubscriptionTopics.add(subscription.topic);
        continue;
      }

      const key = converterKey(subscription.topic, subscriberTopic.schemaName ?? "<no-schema>");
      let existingContractConverters = topicSchemaContractConverters.get(key);
      const converters = (messageContractConverters ?? []).filter(
        (converter) =>
          converter.toSchemaName === subscription.convertTo &&
          isRequiredContractSatisfied(subscriberTopic.providedContract, converter.requiresContract),
      );
      const converter = _.minBy(converters, (conv) => conv.extensionNamespace ?? "unknown");
      if (converter != undefined) {
        existingContractConverters ??= [];
        existingContractConverters.push(converter);
        topicSchemaContractConverters.set(key, existingContractConverters);
      } else {
        log.warn(
          `No contract converter found for topic '${subscription.topic}' with target schema '${subscription.convertTo}'.`,
        );
      }
      continue;
    }

    if (!subscription.convertTo) {
      unconvertedSubscriptionTopics.add(subscription.topic);
      const topicContract = subscriberTopic.providedContract;
      if (topicContract != undefined) {
        const adapter = adapterByContractId.get(topicContract.contractId);
        if (adapter?.toJson != undefined) {
          topicJsonAdapters.set(subscription.topic, adapter);
        }
      }
      continue;
    }

    // If the convertTo is the same as the original schema for the topic then we don't need to
    // perform a conversion.
    const noConversion = sortedTopics.find(
      (topic) => topic.name === subscription.topic && topic.schemaName === subscription.convertTo,
    );
    if (noConversion) {
      unconvertedSubscriptionTopics.add(noConversion.name);
      continue;
    }

    // Since we don't have an existing topic with out destination schema we need to find
    // a converter that will convert from the topic to the desired schema
    const key = converterKey(subscription.topic, subscriberTopic.schemaName ?? "<no-schema>");
    let existingConverters = topicSchemaConverters.get(key);

    // We've already stored a converter for this topic to convertTo
    const haveConverter = existingConverters?.find(
      (conv) => conv.toSchemaName === subscription.convertTo,
    );
    if (haveConverter) {
      continue;
    }

    // Find a converter that can go from the original topic schema to the target schema
    const converters = (messageConverters ?? []).filter(
      (conv) =>
        conv.fromSchemaName === subscriberTopic.schemaName &&
        conv.toSchemaName === subscription.convertTo,
    );
    // Prefer 'local' converters over 'org' provided ones
    const converter = _.minBy(converters, (conv) => conv.extensionNamespace ?? "unknown");

    if (converter) {
      existingConverters ??= [];
      existingConverters.push(converter);
      topicSchemaConverters.set(key, existingConverters);
      continue;
    }

    // Fallback for adapter-backed streams: if no legacy schema converter exists, try contract converters.
    const contractConverters = (messageContractConverters ?? []).filter(
      (conv) =>
        conv.toSchemaName === subscription.convertTo &&
        isRequiredContractSatisfied(subscriberTopic.providedContract, conv.requiresContract),
    );
    const contractConverter = _.minBy(
      contractConverters,
      (conv) => conv.extensionNamespace ?? "unknown",
    );
    if (contractConverter != undefined) {
      let existingContractConverters = topicSchemaContractConverters.get(key);
      existingContractConverters ??= [];
      existingContractConverters.push(contractConverter);
      topicSchemaContractConverters.set(key, existingContractConverters);
    }
  }

  return {
    unconvertedSubscriptionTopics,
    topicSchemaConverters,
    topicSchemaContractConverters,
    topicJsonAdapters,
  };
}

/**
 * Function to iterate and call function over multiple sorted arrays in sorted order across all items in all arrays.
 * Time complexity is O(t*n) where t is the number of arrays and n is the total number of items in all arrays.
 * Space complexity is O(t) where t is the number of arrays.
 * @param arrays - sorted arrays to iterate over
 * @param compareFn - function called to compare items in arrays. Returns a positive value if left is larger than right,
 *  a negative value if right is larger than left, or zero if both are equal
 * @param forEach - callback to be executed on all items in the arrays to iterate over in sorted order across all arrays
 */
export function forEachSortedArrays<Item>(
  arrays: Immutable<Item[][]>,
  compareFn: (a: Immutable<Item>, b: Immutable<Item>) => number,
  forEach: (item: Immutable<Item>) => void,
): void {
  const cursors: number[] = Array(arrays.length).fill(0);
  if (arrays.length === 0) {
    return;
  }
  for (;;) {
    let minCursorIndex: number | undefined = undefined;
    for (let i = 0; i < cursors.length; i++) {
      const cursor = cursors[i]!;
      const array = arrays[i]!;
      if (cursor >= array.length) {
        continue;
      }
      const item = array[cursor]!;
      if (minCursorIndex == undefined) {
        minCursorIndex = i;
      } else {
        const minItem = arrays[minCursorIndex]![cursors[minCursorIndex]!]!;
        if (compareFn(item, minItem) < 0) {
          minCursorIndex = i;
        }
      }
    }
    if (minCursorIndex == undefined) {
      break;
    }
    const minItem = arrays[minCursorIndex]![cursors[minCursorIndex]!];
    if (minItem != undefined) {
      forEach(minItem);
      cursors[minCursorIndex]!++;
    } else {
      break;
    }
  }
}
