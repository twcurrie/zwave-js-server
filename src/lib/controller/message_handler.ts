import {
  createDeferredPromise,
  DeferredPromise,
} from "alcalzone-shared/deferred-promise";
import {
  Driver,
  InclusionGrant,
  InclusionOptions,
  InclusionStrategy,
  ReplaceNodeOptions,
} from "zwave-js";
import {
  InclusionAlreadyInProgressError,
  InclusionPhaseNotInProgressError,
  UnknownCommandError,
} from "../error";
import { Client, ClientsController } from "../server";
import { ControllerCommand } from "./command";
import {
  IncomingCommandControllerBeginInclusion,
  IncomingCommandControllerBeginInclusionLegacy,
  IncomingCommandControllerReplaceFailedNode,
  IncomingCommandControllerReplaceFailedNodeLegacy,
  IncomingMessageController,
} from "./incoming_message";
import { ControllerResultTypes } from "./outgoing_message";

export class ControllerMessageHandler {
  static async handle(
    message: IncomingMessageController,
    clientsController: ClientsController,
    driver: Driver,
    client: Client
  ): Promise<ControllerResultTypes[ControllerCommand]> {
    const { command } = message;

    switch (message.command) {
      case ControllerCommand.beginInclusion: {
        if (
          clientsController.grantSecurityClassesPromise ||
          clientsController.validateDSKAndEnterPinPromise
        )
          throw new InclusionAlreadyInProgressError();
        const success = await driver.controller.beginInclusion(
          processInclusionOptions(clientsController, client, message)
        );
        return { success };
      }
      case ControllerCommand.grantSecurityClasses: {
        if (!clientsController.grantSecurityClassesPromise)
          throw new InclusionPhaseNotInProgressError(
            "grantSecurityClassesPromise"
          );
        clientsController.grantSecurityClassesPromise.resolve(
          message.inclusionGrant
        );
        return {};
      }
      case ControllerCommand.validateDSKAndEnterPIN: {
        if (!clientsController.validateDSKAndEnterPinPromise)
          throw new InclusionPhaseNotInProgressError(
            "validateDSKAndEnterPinPromise"
          );
        clientsController.validateDSKAndEnterPinPromise.resolve(message.pin);
        return {};
      }
      case ControllerCommand.stopInclusion: {
        const success = await driver.controller.stopInclusion();
        return { success };
      }
      case ControllerCommand.beginExclusion: {
        const success = await driver.controller.beginExclusion();
        return { success };
      }
      case ControllerCommand.stopExclusion: {
        const success = await driver.controller.stopExclusion();
        return { success };
      }
      case ControllerCommand.removeFailedNode: {
        await driver.controller.removeFailedNode(message.nodeId);
        return {};
      }
      case ControllerCommand.replaceFailedNode: {
        const success = await driver.controller.replaceFailedNode(
          message.nodeId,
          processInclusionOptions(
            clientsController,
            client,
            message
          ) as ReplaceNodeOptions
        );
        return { success };
      }
      case ControllerCommand.healNode: {
        const success = await driver.controller.healNode(message.nodeId);
        return { success };
      }
      case ControllerCommand.beginHealingNetwork: {
        const success = driver.controller.beginHealingNetwork();
        return { success };
      }
      case ControllerCommand.stopHealingNetwork: {
        const success = driver.controller.stopHealingNetwork();
        return { success };
      }
      case ControllerCommand.isFailedNode: {
        const failed = await driver.controller.isFailedNode(message.nodeId);
        return { failed };
      }
      case ControllerCommand.getAssociationGroups: {
        const groups: ControllerResultTypes[ControllerCommand.getAssociationGroups]["groups"] =
          {};
        driver.controller
          .getAssociationGroups({
            nodeId: message.nodeId,
            endpoint: message.endpoint,
          })
          .forEach((value, key) => (groups[key] = value));
        return { groups };
      }
      case ControllerCommand.getAssociations: {
        const associations: ControllerResultTypes[ControllerCommand.getAssociations]["associations"] =
          {};
        driver.controller
          .getAssociations({
            nodeId: message.nodeId,
            endpoint: message.endpoint,
          })
          .forEach((value, key) => (associations[key] = value));
        return { associations };
      }
      case ControllerCommand.isAssociationAllowed: {
        const allowed = driver.controller.isAssociationAllowed(
          { nodeId: message.nodeId, endpoint: message.endpoint },
          message.group,
          message.association
        );
        return { allowed };
      }
      case ControllerCommand.addAssociations: {
        await driver.controller.addAssociations(
          { nodeId: message.nodeId, endpoint: message.endpoint },
          message.group,
          message.associations
        );
        return {};
      }
      case ControllerCommand.removeAssociations: {
        await driver.controller.removeAssociations(
          { nodeId: message.nodeId, endpoint: message.endpoint },
          message.group,
          message.associations
        );
        return {};
      }
      case ControllerCommand.removeNodeFromAllAssocations:
      case ControllerCommand.removeNodeFromAllAssociations: {
        await driver.controller.removeNodeFromAllAssociations(message.nodeId);
        return {};
      }
      case ControllerCommand.getNodeNeighbors:
        const neighbors = await driver.controller.getNodeNeighbors(
          message.nodeId
        );
        return { neighbors };
      default:
        throw new UnknownCommandError(command);
    }
  }
}

function processInclusionOptions(
  clientsController: ClientsController,
  client: Client,
  message:
    | IncomingCommandControllerBeginInclusion
    | IncomingCommandControllerBeginInclusionLegacy
    | IncomingCommandControllerReplaceFailedNode
    | IncomingCommandControllerReplaceFailedNodeLegacy
): InclusionOptions | ReplaceNodeOptions {
  // Schema 8+ inclusion handling
  if ("options" in message) {
    const options = message.options;
    if (
      options.strategy === InclusionStrategy.Default ||
      options.strategy === InclusionStrategy.Security_S2
    ) {
      let grantSecurityClassesPromise:
        | DeferredPromise<InclusionGrant | false>
        | undefined;
      let validateDSKAndEnterPinPromise:
        | DeferredPromise<string | false>
        | undefined;
      options.userCallbacks = {
        grantSecurityClasses: (
          requested: InclusionGrant
        ): Promise<InclusionGrant | false> => {
          clientsController.grantSecurityClassesPromise =
            grantSecurityClassesPromise = createDeferredPromise();
          grantSecurityClassesPromise.finally(() => {
            if (
              clientsController.grantSecurityClassesPromise ===
              grantSecurityClassesPromise
            ) {
              delete clientsController.grantSecurityClassesPromise;
            }
          });
          client.sendEvent({
            source: "controller",
            event: "grant security classes",
            requested: requested as any,
          });

          return clientsController.grantSecurityClassesPromise;
        },
        validateDSKAndEnterPIN: (dsk: string): Promise<string | false> => {
          clientsController.validateDSKAndEnterPinPromise =
            validateDSKAndEnterPinPromise = createDeferredPromise();
          validateDSKAndEnterPinPromise.finally(() => {
            if (
              clientsController.validateDSKAndEnterPinPromise ===
              validateDSKAndEnterPinPromise
            ) {
              delete clientsController.validateDSKAndEnterPinPromise;
            }
          });
          client.sendEvent({
            source: "controller",
            event: "validate dsk and enter pin",
            dsk,
          });
          return clientsController.validateDSKAndEnterPinPromise;
        },
        abort: (): void => {
          grantSecurityClassesPromise?.reject("aborted");
          validateDSKAndEnterPinPromise?.reject("aborted");
          client.sendEvent({
            source: "controller",
            event: "inclusion aborted",
          });
        },
      };
    }
    return options;
  }
  // Schema <=7 inclusion handling (backwards compatibility logic)
  if ("includeNonSecure" in message && message.includeNonSecure)
    return {
      strategy: InclusionStrategy.Insecure,
    };
  return {
    strategy: InclusionStrategy.Security_S0,
  };
}
