// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { pickFields } from "@lichtblick/den/records";
import Logger from "@lichtblick/log";
import { parseChannel, SchemaDefinition } from "@lichtblick/mcap-support";
import { MessageEvent } from "@lichtblick/suite";
import {
  MessageIteratorArgs,
  IteratorResult,
  GetBackfillMessagesArgs,
  IDeserializedIterableSource,
  Initialization,
  IIterableSource,
} from "@lichtblick/suite-base/players/IterablePlayer/IIterableSource";
import { estimateObjectSize } from "@lichtblick/suite-base/players/messageMemoryEstimation";
import { SubscribePayload } from "@lichtblick/suite-base/players/types";

const log = Logger.getLogger(__filename);

// Computes the subscription hash for a given topic & subscription payload pair.
// In the simplest case, when there are no message slicing fields, the subscription hash is just
// the topic name. If there are slicing fields, the hash is computed as the topic name appended
// by "+" seperated message slicing fields.
function computeSubscriptionHash(topic: string, subscribePayload: SubscribePayload): string {
  return subscribePayload.fields ? topic + "+" + subscribePayload.fields.join("+") : topic;
}

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

type SchemaDefinitionWithSource = SchemaDefinition & {
  extensionId?: string;
  extensionNamespace?: string;
  conflictingSchemaDefinitions?: Array<SchemaDefinitionWithSource>;
};

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

/**
 * Iterable source that deserializes messages from a raw iterable source (messages are Uint8Arrays).
 */
export class DeserializingIterableSource implements IDeserializedIterableSource {
  #source: IIterableSource<Uint8Array>;
  #deserializersByTopic: Record<string, (data: ArrayBufferView) => unknown> = {};
  #messageSizeEstimateBySubHash: Record<string, number> = {};
  #connectionIdByTopic: Record<string, number> = {};
  #schemaDefinitionsByName?: Map<string, SchemaDefinition>;
  #failedTopics = new Set<string>();

  public readonly sourceType = "deserialized";

  public constructor(
    source: IIterableSource<Uint8Array>,
    schemaDefinitionsByName?: Map<string, SchemaDefinition>,
  ) {
    this.#source = source;
    this.#schemaDefinitionsByName = schemaDefinitionsByName;
  }

  public async initialize(): Promise<Initialization> {
    return this.initializeDeserializers(await this.#source.initialize());
  }

  public initializeDeserializers(initResult: Initialization): Initialization {
    const alerts: Initialization["alerts"] = [];

    let nextConnectionId = 0;
    for (const {
      name: topic,
      messageEncoding,
      schemaName,
      schemaData,
      schemaEncoding,
    } of initResult.topics) {
      this.#connectionIdByTopic[topic] = nextConnectionId++;

      if (this.#deserializersByTopic[topic] == undefined) {
        let usedRegistrySchema = false;
        let selectedRegistrySchema: SchemaDefinitionWithSource | undefined;
        let selectedRegistryCandidates: SchemaDefinitionWithSource[] = [];
        try {
          if (messageEncoding == undefined) {
            throw new Error(`Unspecified message encoding for topic ${topic}`);
          }

          let candidateSchemas: SchemaDefinitionWithSource[] = [];

          if (schemaName != undefined) {
            if (schemaEncoding != undefined) {
              const schema = this.#schemaDefinitionsByName?.get(
                schemaDefinitionKey(schemaName, schemaEncoding),
              );
              if (schema != undefined) {
                candidateSchemas = expandAndSortSchemaCandidates(
                  schema as SchemaDefinitionWithSource,
                );
              }
            } else {
              for (const preferredEncoding of preferredSchemaEncodings(messageEncoding)) {
                const schema = this.#schemaDefinitionsByName?.get(
                  schemaDefinitionKey(schemaName, preferredEncoding),
                );
                if (schema != undefined) {
                  candidateSchemas = expandAndSortSchemaCandidates(
                    schema as SchemaDefinitionWithSource,
                  );
                  break;
                }
              }

              if (candidateSchemas.length === 0) {
                const allSchemasForName =
                  this.#schemaDefinitionsByName == undefined
                    ? []
                    : Array.from(this.#schemaDefinitionsByName.values()).filter(
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
                  this.#deserializersByTopic[topic] = deserialize;
                  selectedRegistrySchema = candidateSchema;
                  selectedRegistryCandidates = candidateSchemas;
                  usedRegistrySchema = true;
                  break;
                } catch {
                  // Try the next registered schema candidate.
                }
              }
              if (!usedRegistrySchema) {
                throw new Error(
                  `No compatible registered schema definition found for ${schemaName}.`,
                );
              }
            } else if (this.#schemaDefinitionsByName != undefined) {
              const schemaVariants = Array.from(this.#schemaDefinitionsByName.values()).filter(
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

          if (usedRegistrySchema && selectedRegistrySchema != undefined) {
            alerts.push({
              severity: "info",
              message: `Using registered schema definition for ${schemaName} (${selectedRegistrySchema.encoding}) from ${describeSchemaSource(
                selectedRegistrySchema,
              )}.`,
            });

            if (selectedRegistryCandidates.length > 1) {
              alerts.push({
                severity: "warn",
                message: `Using registered schema definition from ${describeSchemaSource(selectedRegistrySchema)}.`,
                error: Error(
                  `Multiple registered schema definitions found for ${schemaName} (${selectedRegistrySchema.encoding}).`,
                ),
              });
            }
          } else {
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
            this.#deserializersByTopic[topic] = deserialize;

            if (
              schemaName != undefined &&
              (schemaData != undefined || schemaEncoding != undefined)
            ) {
              log.info("Using MCAP schema definition for topic", {
                topic,
                schemaName,
                schemaEncoding,
                hasSchemaData: schemaData != undefined,
              });
            }
          }
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
                  messageEncoding: messageEncoding!,
                  schema: mcapSchema,
                });
                this.#deserializersByTopic[topic] = deserialize;
                log.warn(
                  "Failed to use registered schema definition for topic, trying MCAP schema",
                  {
                    topic,
                    schemaName,
                    mcapSchemaEncoding: schemaEncoding,
                  },
                );
                alerts.push({
                  severity: "warn",
                  message: `Falling back to MCAP schema definition.`,
                  error: Error(`Failed to use registered schema definition for ${schemaName}.`),
                });
                continue;
              } catch {
                // Continue to the generic error path if MCAP fallback is also invalid.
              }
            }
          }
          this.#failedTopics.add(topic);
          alerts.push({
            severity: "error",
            message: `Error in topic ${topic}`,
            error: error as Error,
          });
        }
      }
    }

    return { ...initResult, alerts: initResult.alerts.concat(alerts) };
  }

  public messageIterator(
    args: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult>> {
    // Compute the unique subscription hash for every topic + subscription payload pair which will
    // be used to lookup message size estimates. This is done here to avoid having to compute the
    // the subscription hash for every new message event.
    const subscribePayloadWithHashByTopic = new Map(
      Array.from(args.topics, ([topic, subscribePayload]) => [
        topic,
        {
          ...subscribePayload,
          subscriptionHash: computeSubscriptionHash(topic, subscribePayload),
        },
      ]),
    );

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const rawIterator = self.#source.messageIterator(args);
    return (async function* deserializedIterableGenerator() {
      try {
        for await (const iterResult of rawIterator) {
          if (iterResult.type !== "message-event") {
            yield iterResult;
            continue;
          }

          try {
            const subscription = subscribePayloadWithHashByTopic.get(iterResult.msgEvent.topic);
            if (!subscription) {
              throw new Error(
                `Received message on topic ${iterResult.msgEvent.topic} which was not subscribed to.`,
              );
            }
            if (self.#failedTopics.has(iterResult.msgEvent.topic)) {
              continue;
            }

            const deserializedMsgEvent = self.#deserializeMessage(
              iterResult.msgEvent,
              subscription,
            );
            yield {
              type: iterResult.type,
              msgEvent: deserializedMsgEvent,
            };
          } catch (err) {
            const connectionId = self.#connectionIdByTopic[iterResult.msgEvent.topic] ?? 0;
            yield {
              type: "alert",
              connectionId,
              alert: {
                severity: "error",
                message: `Failed to deserialize message on topic ${
                  iterResult.msgEvent.topic
                }. ${err.toString()}`,
                tip: `Check that your input file is not corrupted.`,
              },
            };
          }
        }
      } finally {
        await rawIterator.return?.();
      }
    })();
  }

  public async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    // Compute the unique subscription hash for every topic + subscription payload pair which will
    // be used to lookup message size estimates. This is done here to avoid having to compute the
    // the subscription hash for every new message event.
    const subscribePayloadWithHashByTopic = new Map(
      Array.from(args.topics, ([topic, subscribePayload]) => [
        topic,
        {
          ...subscribePayload,
          subscriptionHash: computeSubscriptionHash(topic, subscribePayload),
        },
      ]),
    );

    const rawMessages = await this.#source.getBackfillMessages(args);
    const deserializedMsgs: MessageEvent[] = [];
    for (const rawMsg of rawMessages) {
      try {
        const subscription = subscribePayloadWithHashByTopic.get(rawMsg.topic);
        if (!subscription) {
          throw new Error(`Received message on topic ${rawMsg.topic} which was not subscribed to.`);
        }
        if (this.#failedTopics.has(rawMsg.topic)) {
          continue;
        }
        deserializedMsgs.push(this.#deserializeMessage(rawMsg, subscription));
      } catch (err) {
        // We simply log errors here as there is no way to pass errors/problems to the caller.
        // Besides this, the error has most likely been already surfaced to the user during normal iteration.
        log.error(err);
      }
    }

    return deserializedMsgs;
  }

  #deserializeMessage(
    rawMessageEvent: MessageEvent<Uint8Array>,
    subscription: SubscribePayload & { subscriptionHash: string },
  ): MessageEvent {
    const { topic, message } = rawMessageEvent;

    const deserialize = this.#deserializersByTopic[topic];
    if (!deserialize) {
      throw new Error(`Failed to find deserializer for topic ${topic}`);
    }

    const deserializedMessage = deserialize(message) as Record<string, unknown>;
    const msg = subscription.fields
      ? pickFields(deserializedMessage, subscription.fields)
      : deserializedMessage;

    // Lookup the size estimate for this subscription hash or compute it if not found in the cache.
    let msgSizeEstimate = this.#messageSizeEstimateBySubHash[subscription.subscriptionHash];
    if (msgSizeEstimate == undefined) {
      msgSizeEstimate = estimateObjectSize(msg);
      this.#messageSizeEstimateBySubHash[subscription.subscriptionHash] = msgSizeEstimate;
    }

    // For sliced messages we use the estimated message size whereas for non-sliced messages
    // take whatever size is bigger.
    const sizeInBytes = subscription.fields
      ? msgSizeEstimate
      : Math.max(message.byteLength, msgSizeEstimate);

    return {
      ...rawMessageEvent,
      message: msg,
      sizeInBytes,
    };
  }
}
