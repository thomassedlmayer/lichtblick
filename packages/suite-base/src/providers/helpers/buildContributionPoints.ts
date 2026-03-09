// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as _ from "lodash-es";
import ReactDOM from "react-dom";

import { CameraModelsMap } from "@lichtblick/den/image/types";
import Logger from "@lichtblick/log";
import {
  RegisterMessageConverterArgs,
  MessageAdapter,
  MessageContractConverter,
  ExtensionContext,
  TopicAliasFunction,
  ExtensionModule,
  ExtensionPanelRegistration,
  RegisterCameraModelArgs,
} from "@lichtblick/suite";
import { ExtensionSettings } from "@lichtblick/suite-base/components/PanelSettings/types";
import {
  ContributionPoints,
  RegisteredPanel,
  MessageConverter,
  RegisteredMessageAdapter,
  RegisteredMessageContractConverter,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import { ExtensionInfo } from "@lichtblick/suite-base/types/Extensions";

const log = Logger.getLogger(__filename);

export function buildContributionPoints(
  extension: ExtensionInfo,
  unwrappedExtensionSource: string,
): ContributionPoints {
  // registered panels stored by their fully qualified id
  // the fully qualified id is the extension name + panel name
  const panels: Record<string, RegisteredPanel> = {};
  const messageConverters: RegisterMessageConverterArgs<unknown>[] = [];
  const messageAdapters: MessageAdapter<unknown>[] = [];
  const messageContractConverters: MessageContractConverter<unknown>[] = [];
  const panelSettings: ExtensionSettings = {};
  const topicAliasFunctions: ContributionPoints["topicAliasFunctions"] = [];
  const cameraModels: CameraModelsMap = new Map();

  log.debug(`Mounting extension ${extension.qualifiedName}`);

  const module = { exports: {} };
  const require = (name: string) => {
    return { react: React, "react-dom": ReactDOM }[name];
  };

  const extensionMode =
    process.env.NODE_ENV === "production"
      ? "production"
      : process.env.NODE_ENV === "test"
        ? "test"
        : "development";

  const ctx: ExtensionContext = {
    mode: extensionMode,

    registerPanel: (registration: ExtensionPanelRegistration) => {
      log.debug(`Extension ${extension.qualifiedName} registering panel: ${registration.name}`);

      const panelId = `${extension.qualifiedName}.${registration.name}`;
      if (panels[panelId]) {
        log.warn(`Panel ${panelId} is already registered`);
        return;
      }

      panels[panelId] = {
        extensionId: extension.id,
        extensionName: extension.qualifiedName,
        extensionNamespace: extension.namespace,
        registration,
      };
    },

    registerMessageConverter: <Src>(messageConverter: RegisterMessageConverterArgs<Src>) => {
      log.debug(
        `Extension ${extension.qualifiedName} registering message converter from: ${messageConverter.fromSchemaName} to: ${messageConverter.toSchemaName}`,
      );

      messageConverters.push({
        ...messageConverter,
        extensionNamespace: extension.namespace,
        extensionId: extension.id,
      } as MessageConverter);

      const converterSettings = _.mapValues(messageConverter.panelSettings, (settings) => ({
        [messageConverter.fromSchemaName]: settings,
      }));

      _.merge(panelSettings, converterSettings);
    },

    registerMessageAdapter: <Decoded>(messageAdapter: MessageAdapter<Decoded>) => {
      log.debug(
        `Extension ${extension.qualifiedName} registering message adapter: ${messageAdapter.id}`,
      );
      if (messageAdapters.some((adapter) => adapter.id === messageAdapter.id)) {
        log.warn(
          `Extension ${extension.qualifiedName} registered duplicate message adapter id: ${messageAdapter.id}`,
        );
        return;
      }
      messageAdapters.push(messageAdapter as RegisteredMessageAdapter);
    },

    registerMessageContractConverter: <Decoded>(
      messageContractConverter: MessageContractConverter<Decoded>,
    ) => {
      log.debug(
        `Extension ${extension.qualifiedName} registering message contract converter: ${messageContractConverter.id}`,
      );
      if (
        messageContractConverters.some((converter) => converter.id === messageContractConverter.id)
      ) {
        log.warn(
          `Extension ${extension.qualifiedName} registered duplicate message contract converter id: ${messageContractConverter.id}`,
        );
        return;
      }
      messageContractConverters.push(
        messageContractConverter as RegisteredMessageContractConverter,
      );
    },

    registerTopicAliases: (aliasFunction: TopicAliasFunction) => {
      topicAliasFunctions.push({ aliasFunction, extensionId: extension.id });
    },

    registerCameraModel({ name, modelBuilder }: RegisterCameraModelArgs) {
      log.debug(`Extension ${extension.qualifiedName} registering camera model: ${name}`);

      cameraModels.set(name, { extensionId: extension.id, modelBuilder });
    },
  };

  try {
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    const fn = new Function("module", "require", unwrappedExtensionSource);

    // load the extension module exports
    fn(module, require, {});
    const wrappedExtensionModule = module.exports as ExtensionModule;

    wrappedExtensionModule.activate(ctx);
  } catch (err: unknown) {
    log.error(err);
  }

  return {
    panels,
    messageConverters,
    messageAdapters: messageAdapters.map((adapter) => ({
      ...adapter,
      extensionNamespace: extension.namespace,
      extensionId: extension.id,
    })),
    messageContractConverters: messageContractConverters.map((converter) => ({
      ...converter,
      extensionNamespace: extension.namespace,
      extensionId: extension.id,
    })),
    topicAliasFunctions,
    panelSettings,
    cameraModels,
  };
}
