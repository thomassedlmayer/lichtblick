// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Builder } from "flatbuffers";
import fs from "fs";
import protobufjs from "protobufjs";
import { FileDescriptorSet, IFileDescriptorSet } from "protobufjs/ext/descriptor";

import { parseChannel } from "./parseChannel";

describe("parseChannel", () => {
  it("works with json/jsonschema", () => {
    const channel = parseChannel({
      messageEncoding: "json",
      schema: {
        name: "X",
        encoding: "jsonschema",
        data: new TextEncoder().encode(
          JSON.stringify({ type: "object", properties: { value: { type: "string" } } }),
        ),
      },
    });
    expect(channel.deserialize(new TextEncoder().encode(JSON.stringify({ value: "hi" })))).toEqual({
      value: "hi",
    });
  });

  it("works with flatbuffer", () => {
    const reflectionSchema = fs.readFileSync(`${__dirname}/fixtures/reflection.bfbs`);
    const reflectionSchemaUint8 = new Uint8Array(
      reflectionSchema.buffer,
      reflectionSchema.byteOffset,
      reflectionSchema.byteLength,
    );
    const channel = parseChannel({
      messageEncoding: "flatbuffer",
      schema: { name: "reflection.Schema", encoding: "flatbuffer", data: reflectionSchemaUint8 },
    });

    const deserialized = channel.deserialize(reflectionSchema) as {
      objects: Record<string, unknown>[];
    };
    expect(deserialized.objects.length).toEqual(10);
    expect(deserialized.objects[0]!.name).toEqual("reflection.Enum");
  });

  it("works with protobuf", () => {
    const fds = FileDescriptorSet.encode(FileDescriptorSet.root.toDescriptor("proto3")).finish();
    const channel = parseChannel({
      messageEncoding: "protobuf",
      schema: { name: "google.protobuf.FileDescriptorSet", encoding: "protobuf", data: fds },
    });
    const deserialized = channel.deserialize(fds) as IFileDescriptorSet;
    expect(deserialized.file[0]!.name).toEqual("google_protobuf.proto");
  });

  it("should deserialize snake_case two-word fields to identical object keys across encodings", () => {
    const expected = { two_word: 123 };

    // protobuf
    const parsed = protobufjs.parse(
      `
      syntax = "proto3";
      message TwoWordMessage {
        int32 two_word = 1;
      }
    `,
      // This test intentionally assumes a descriptor/runtime mapping that preserves source
      // field casing (snake_case). Without keepCase, protobufjs normalizes to camelCase.
      // Since keepCase is false by default for protobufjs, snake_case expectations are
      // source/config dependent.
      { keepCase: true },
    );
    const rootType = parsed.root.lookupType("TwoWordMessage");
    const protobufSchema = FileDescriptorSet.encode(parsed.root.toDescriptor("proto3")).finish();
    const protobufChannel = parseChannel({
      messageEncoding: "protobuf",
      schema: {
        name: "TwoWordMessage",
        encoding: "protobuf",
        data: protobufSchema,
      },
    });
    const protobufPayload = rootType
      .encode({
        two_word: 123,
      })
      .finish();

    // flatbuffer
    // See fixtures/TwoWordType.fbs for the human-readable schema blueprint.
    const flatbufferSchema = fs.readFileSync(`${__dirname}/fixtures/TwoWordType.bfbs`);
    const flatbufferSchemaData = new Uint8Array(
      flatbufferSchema.buffer,
      flatbufferSchema.byteOffset,
      flatbufferSchema.byteLength,
    );
    const flatbufferChannel = parseChannel({
      messageEncoding: "flatbuffer",
      schema: {
        name: "TwoWordMessage",
        encoding: "flatbuffer",
        data: flatbufferSchemaData,
      },
    });

    const flatbufferBuilder = new Builder();
    flatbufferBuilder.startObject(1);
    flatbufferBuilder.addFieldInt32(0, 123, 0);
    const objectOffset = flatbufferBuilder.endObject();
    flatbufferBuilder.finish(objectOffset);
    const flatbufferPayload = Uint8Array.from(flatbufferBuilder.asUint8Array());

    // json
    const jsonChannel = parseChannel({
      messageEncoding: "json",
      schema: {
        name: "TwoWordMessage",
        encoding: "jsonschema",
        data: new TextEncoder().encode(
          JSON.stringify({
            type: "object",
            properties: { two_word: { type: "integer" } },
          }),
        ),
      },
    });
    const jsonPayload = new TextEncoder().encode(JSON.stringify(expected));

    expect(protobufChannel.deserialize(protobufPayload)).toEqual(expected);
    expect(flatbufferChannel.deserialize(flatbufferPayload)).toEqual(expected);
    expect(jsonChannel.deserialize(jsonPayload)).toEqual(expected);
  });

  it("should deserialize camelCase two-word fields to identical object keys across encodings", () => {
    const expected = { twoWord: 123 };

    // protobuf
    const parsed = protobufjs.parse(`
      syntax = "proto3";
      message TwoWordCamelMessage {
        int32 twoWord = 1;
      }
    `);
    const rootType = parsed.root.lookupType("TwoWordCamelMessage");
    const protobufSchema = FileDescriptorSet.encode(parsed.root.toDescriptor("proto3")).finish();
    const protobufChannel = parseChannel({
      messageEncoding: "protobuf",
      schema: {
        name: "TwoWordCamelMessage",
        encoding: "protobuf",
        data: protobufSchema,
      },
    });
    const protobufPayload = rootType
      .encode({
        twoWord: 123,
      })
      .finish();

    // flatbuffer
    // See fixtures/TwoWordCamelType.fbs for the human-readable schema blueprint.
    const flatbufferSchema = fs.readFileSync(`${__dirname}/fixtures/TwoWordCamelType.bfbs`);
    const flatbufferSchemaData = new Uint8Array(
      flatbufferSchema.buffer,
      flatbufferSchema.byteOffset,
      flatbufferSchema.byteLength,
    );
    const flatbufferChannel = parseChannel({
      messageEncoding: "flatbuffer",
      schema: {
        name: "TwoWordCamelMessage",
        encoding: "flatbuffer",
        data: flatbufferSchemaData,
      },
    });

    const flatbufferBuilder = new Builder();
    flatbufferBuilder.startObject(1);
    flatbufferBuilder.addFieldInt32(0, 123, 0);
    const objectOffset = flatbufferBuilder.endObject();
    flatbufferBuilder.finish(objectOffset);
    const flatbufferPayload = Uint8Array.from(flatbufferBuilder.asUint8Array());

    // json
    const jsonChannel = parseChannel({
      messageEncoding: "json",
      schema: {
        name: "TwoWordCamelMessage",
        encoding: "jsonschema",
        data: new TextEncoder().encode(
          JSON.stringify({
            type: "object",
            properties: { twoWord: { type: "integer" } },
          }),
        ),
      },
    });
    const jsonPayload = new TextEncoder().encode(JSON.stringify(expected));

    expect(protobufChannel.deserialize(protobufPayload)).toEqual(expected);
    expect(flatbufferChannel.deserialize(flatbufferPayload)).toEqual(expected);
    expect(jsonChannel.deserialize(jsonPayload)).toEqual(expected);
  });

  it("should apply identical missing-field default fallback across encodings", () => {
    // protobuf schema + completely empty payload
    const parsed = protobufjs.parse(`
      syntax = "proto3";
      enum Mode {
        MODE_UNSPECIFIED = 0;
        MODE_ACTIVE = 1;
      }
      message DefaultFallbackContract {
        string name = 1;
        int32 count = 2;
        bool enabled = 3;
        repeated int32 values = 4;
        Mode mode = 5;
        bytes data = 6;
      }
    `);
    const protobufSchema = FileDescriptorSet.encode(parsed.root.toDescriptor("proto3")).finish();
    const protobufChannel = parseChannel({
      messageEncoding: "protobuf",
      schema: {
        name: "DefaultFallbackContract",
        encoding: "protobuf",
        data: protobufSchema,
      },
    });
    const protobufObj = protobufChannel.deserialize(new Uint8Array([]));

    // flatbuffer schema + completely empty payload
    const builder = new Builder();
    builder.startObject(6);
    const byteVector = builder.endObject();
    builder.finish(byteVector);
    const flatbufferPayload = Uint8Array.from(builder.asUint8Array());

    // See fixtures/DefaultFallbackContract.fbs for the human-readable schema blueprint.
    const flatbufferSchema = fs.readFileSync(`${__dirname}/fixtures/DefaultFallbackContract.bfbs`);
    const flatbufferSchemaData = new Uint8Array(
      flatbufferSchema.buffer,
      flatbufferSchema.byteOffset,
      flatbufferSchema.byteLength,
    );
    const flatbufferChannel = parseChannel({
      messageEncoding: "flatbuffer",
      schema: {
        name: "DefaultFallbackContract",
        encoding: "flatbuffer",
        data: flatbufferSchemaData,
      },
    });
    const flatbufferObj = flatbufferChannel.deserialize(flatbufferPayload);

    // json schema + missing property in payload
    const jsonChannel = parseChannel({
      messageEncoding: "json",
      schema: {
        name: "DefaultFallbackContract",
        encoding: "jsonschema",
        data: new TextEncoder().encode(
          JSON.stringify({
            type: "object",
            properties: { data: { type: "string", contentEncoding: "base64" } },
          }),
        ),
      },
    });
    const jsonObj = jsonChannel.deserialize(new TextEncoder().encode(JSON.stringify({})));

    const expected = {
      name: "",
      count: 0,
      enabled: false,
      values: [],
      mode: 0,
      data: new Uint8Array([]),
    };
    expect(protobufObj).toEqual(expected);
    expect(flatbufferObj).toEqual(expected);
    expect(jsonObj).toEqual(expected);
  });

  it("should deserialize timestamp fields to identical output objects across protobuf/json", () => {
    const parsed = protobufjs.parse(`
      syntax = "proto3";
      package google.protobuf;

      message Timestamp {
        int64 seconds = 1;
        int32 nanos = 2;
      }

      message Event {
        Timestamp timestamp = 1;
      }
    `);
    const eventType = parsed.root.lookupType("google.protobuf.Event");
    const protobufSchema = FileDescriptorSet.encode(parsed.root.toDescriptor("proto3")).finish();
    const protobufChannel = parseChannel({
      messageEncoding: "protobuf",
      schema: {
        name: "google.protobuf.Event",
        encoding: "protobuf",
        data: protobufSchema,
      },
    });
    const protobufPayload = eventType
      .encode({
        timestamp: { seconds: 1681334599, nanos: 494227000 },
      })
      .finish();

    const jsonChannel = parseChannel({
      messageEncoding: "json",
      schema: {
        name: "google.protobuf.Event",
        encoding: "jsonschema",
        data: new TextEncoder().encode(
          JSON.stringify({
            type: "object",
            properties: {
              timestamp: {
                type: "object",
                properties: {
                  seconds: { type: "integer" },
                  nanos: { type: "integer" },
                },
              },
            },
          }),
        ),
      },
    });
    const jsonPayload = new TextEncoder().encode(
      JSON.stringify({ timestamp: { seconds: 1681334599, nanos: 494227000 } }),
    );

    // flatbuffer
    // See fixtures/TimestampEvent.fbs for the human-readable schema blueprint.
    const flatbufferSchema = fs.readFileSync(`${__dirname}/fixtures/TimestampEvent.bfbs`);
    const flatbufferSchemaData = new Uint8Array(
      flatbufferSchema.buffer,
      flatbufferSchema.byteOffset,
      flatbufferSchema.byteLength,
    );
    const flatbufferChannel = parseChannel({
      messageEncoding: "flatbuffer",
      schema: {
        name: "Event",
        encoding: "flatbuffer",
        data: flatbufferSchemaData,
      },
    });

    const flatbufferBuilder = new Builder();
    flatbufferBuilder.startObject(2);
    flatbufferBuilder.addFieldInt64(0, BigInt(1681334599), BigInt(0));
    flatbufferBuilder.addFieldInt32(1, 494227000, 0);
    const timestampOffset = flatbufferBuilder.endObject();

    flatbufferBuilder.startObject(1);
    flatbufferBuilder.addFieldOffset(0, timestampOffset, 0);
    const eventOffset = flatbufferBuilder.endObject();
    flatbufferBuilder.finish(eventOffset);
    const flatbufferPayload = Uint8Array.from(flatbufferBuilder.asUint8Array());

    const expected = { timestamp: { seconds: 1681334599, nanos: 494227000 } };
    expect(protobufChannel.deserialize(protobufPayload)).toEqual(expected);
    expect(flatbufferChannel.deserialize(flatbufferPayload)).toEqual(expected);
    expect(jsonChannel.deserialize(jsonPayload)).toEqual(expected);
  });

  it("works with ros1", () => {
    const channel = parseChannel({
      messageEncoding: "ros1",
      schema: {
        name: "foo_msgs/Bar",
        encoding: "ros1msg",
        data: new TextEncoder().encode("string data"),
      },
    });

    const obj = channel.deserialize(new Uint8Array([4, 0, 0, 0, 65, 66, 67, 68]));
    expect(obj).toEqual({ data: "ABCD" });
  });

  it("works with ros2", () => {
    const channel = parseChannel({
      messageEncoding: "cdr",
      schema: {
        name: "foo_msgs/Bar",
        encoding: "ros2msg",
        data: new TextEncoder().encode("string data"),
      },
    });

    const obj = channel.deserialize(new Uint8Array([0, 1, 0, 0, 5, 0, 0, 0, 65, 66, 67, 68, 0]));
    expect(obj).toEqual({ data: "ABCD" });
  });

  it("works with ros2idl", () => {
    const channel = parseChannel({
      messageEncoding: "cdr",
      schema: {
        name: "foo_msgs/Bar",
        encoding: "ros2idl",
        data: new TextEncoder().encode(`
        module foo_msgs {
          struct Bar {string data;};
        };
        `),
      },
    });

    const obj = channel.deserialize(new Uint8Array([0, 1, 0, 0, 5, 0, 0, 0, 65, 66, 67, 68, 0]));
    expect(obj).toEqual({ data: "ABCD" });
  });
  it("works with omgidl xcdr2", () => {
    const channel = parseChannel({
      messageEncoding: "cdr",
      schema: {
        name: "foo_msgs::Bar",
        encoding: "omgidl",
        data: new TextEncoder().encode(`
        enum Color {RED, GREEN, BLUE};
        module foo_msgs {
          struct NonRootBar {string data;};
          struct Bar {foo_msgs::NonRootBar data; Color color;};
        };
        `),
      },
    });

    const obj = channel.deserialize(
      new Uint8Array([0, 1, 0, 0, 5, 0, 0, 0, 65, 66, 67, 68, 0, 0, 0, 0, 2, 0, 0, 0]),
    );
    expect(obj).toEqual({ data: { data: "ABCD" }, color: 2 });
  });
});
