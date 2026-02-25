// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { signal } from "@lichtblick/den/async";
import FoxgloveWebSocketPlayer from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer";
import NoopMetricsCollector from "@lichtblick/suite-base/players/NoopMetricsCollector";

const mockDeserializeCallCountBySchema = new Map<string, number>();
type MockHandler = (...args: unknown[]) => void;
type MockClient = { emit: (event: string, ...args: unknown[]) => void };

let mockLastClient: MockClient | undefined;

jest.mock("@foxglove/ws-protocol", () => {
  class MockFoxgloveClient {
    public static readonly SUPPORTED_SUBPROTOCOL = "foxglove.websocket.v1";

    #handlers = new Map<string, MockHandler[]>();
    #nextSubscriptionId = 1;

    public on(event: string, handler: MockHandler): void {
      const handlers = this.#handlers.get(event) ?? [];
      handlers.push(handler);
      this.#handlers.set(event, handlers);
    }

    public emit(event: string, ...args: unknown[]): void {
      for (const handler of this.#handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    public close(): void {
      // no-op
    }

    public subscribe(_channelId: number): number {
      return this.#nextSubscriptionId++;
    }

    public unsubscribe(_subscriptionId: number): void {
      // no-op
    }

    public subscribeConnectionGraph(): void {
      // no-op
    }

    public getParameters(): void {
      // no-op
    }

    public advertise(): number {
      return 1;
    }

    public unadvertise(): void {
      // no-op
    }

    public sendMessage(): void {
      // no-op
    }

    public setParameters(): void {
      // no-op
    }

    public sendServiceCallRequest(): void {
      // no-op
    }

    public sendFetchAssetRequest(): void {
      // no-op
    }
  }

  return {
    __esModule: true,
    FoxgloveClient: function FoxgloveClient() {
      const client = new MockFoxgloveClient();
      mockLastClient = client;
      return client;
    },
    ServerCapability: {
      time: "time",
      clientPublish: "clientPublish",
      services: "services",
      parameters: "parameters",
      parametersSubscribe: "parametersSubscribe",
      connectionGraph: "connectionGraph",
      assets: "assets",
    },
    StatusLevel: {
      INFO: 0,
      WARNING: 1,
      ERROR: 2,
    },
    FetchAssetStatus: {
      SUCCESS: "success",
      ERROR: "error",
    },
    BinaryOpcode: {
      FETCH_ASSET_RESPONSE: "fetch_asset_response",
    },
  };
});

jest.mock("@lichtblick/mcap-support", () => {
  return {
    __esModule: true,
    parseChannel: jest.fn((args: { schema: { name: string } }) => {
      return {
        datatypes: new Map(),
        deserialize: (data: DataView | Uint8Array) => {
          const currentCount = mockDeserializeCallCountBySchema.get(args.schema.name) ?? 0;
          mockDeserializeCallCountBySchema.set(args.schema.name, currentCount + 1);
          const bytes =
            data instanceof Uint8Array
              ? data
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          return { value: bytes[0] };
        },
      };
    }),
  };
});

describe("FoxgloveWebSocketPlayer sampling", () => {
  beforeEach(() => {
    mockDeserializeCallCountBySchema.clear();
    mockLastClient = undefined;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: function MockWebSocket() {
        return undefined;
      },
    });
  });

  it("deserializes only latest sampled messages per emit window", async () => {
    const emitRelease = signal();
    const statesWithMessages: unknown[][] = [];

    const player = new FoxgloveWebSocketPlayer({
      url: "ws://localhost:8765",
      metricsCollector: new NoopMetricsCollector(),
      sourceId: "foxglove-websocket",
    });

    player.setListener(async ({ activeData }) => {
      if (activeData?.messages) {
        statesWithMessages.push(activeData.messages);
      }
      await emitRelease;
    });

    const client = mockLastClient;
    if (!client) {
      throw new Error("Expected mocked client to be created");
    }

    client.emit("open");
    client.emit("serverInfo", {
      capabilities: [],
      name: "mock-server",
      supportedEncodings: ["json"],
    });
    client.emit("advertise", [
      {
        id: 1,
        topic: "/sampled",
        schemaName: "SampledSchema",
        encoding: "json",
        schema: "{}",
      },
      {
        id: 2,
        topic: "/unsampled",
        schemaName: "UnsampledSchema",
        encoding: "json",
        schema: "{}",
      },
    ]);

    player.setSubscriptions([
      { topic: "/sampled", sampling: { mode: "latest-per-render-tick" } },
      { topic: "/unsampled" },
    ]);

    client.emit("message", {
      subscriptionId: 1,
      data: new DataView(Uint8Array.from([1]).buffer),
    });
    client.emit("message", {
      subscriptionId: 2,
      data: new DataView(Uint8Array.from([10]).buffer),
    });
    client.emit("message", {
      subscriptionId: 1,
      data: new DataView(Uint8Array.from([2]).buffer),
    });
    client.emit("message", {
      subscriptionId: 2,
      data: new DataView(Uint8Array.from([11]).buffer),
    });
    client.emit("message", {
      subscriptionId: 1,
      data: new DataView(Uint8Array.from([3]).buffer),
    });

    emitRelease.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const latestMessages = statesWithMessages.at(-1);
    expect(latestMessages).toBeDefined();
    const sampledMessages = (latestMessages ?? []).filter(
      (message: { topic: string }) => message.topic === "/sampled",
    );
    const unsampledMessages = (latestMessages ?? []).filter(
      (message: { topic: string }) => message.topic === "/unsampled",
    );

    expect(sampledMessages).toHaveLength(1);
    expect(sampledMessages[0]).toMatchObject({ message: { value: 3 } });
    expect(unsampledMessages).toHaveLength(2);
    expect(mockDeserializeCallCountBySchema.get("SampledSchema")).toBe(1);
    expect(mockDeserializeCallCountBySchema.get("UnsampledSchema")).toBe(2);

    player.close();
  });
});
