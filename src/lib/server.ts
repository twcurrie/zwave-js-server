import ws from "ws";
import type WebSocket from "ws";
import { Driver, InclusionGrant, ZWaveError, ZWaveErrorCodes } from "zwave-js";
import { libVersion } from "zwave-js";
import { DeferredPromise } from "alcalzone-shared/deferred-promise";
import { EventForwarder } from "./forward";
import type * as OutgoingMessages from "./outgoing_message";
import { IncomingMessage } from "./incoming_message";
import { dumpLogConfig, dumpState } from "./state";
import { Server as HttpServer, createServer } from "http";
import { EventEmitter, once } from "events";
import { version, minSchemaVersion, maxSchemaVersion } from "./const";
import { NodeMessageHandler } from "./node/message_handler";
import { ControllerMessageHandler } from "./controller/message_handler";
import { IncomingMessageController } from "./controller/incoming_message";
import {
  BaseError,
  ErrorCode,
  SchemaIncompatibleError,
  UnknownCommandError,
} from "./error";
import { Instance } from "./instance";
import { IncomingMessageNode } from "./node/incoming_message";
import { ServerCommand } from "./command";
import { DriverMessageHandler } from "./driver/message_handler";
import { IncomingMessageDriver } from "./driver/incoming_message";
import { LoggingEventForwarder } from "./logging";
import { BroadcastNodeMessageHandler } from "./broadcast_node/message_handler";
import { IncomingMessageBroadcastNode } from "./broadcast_node/incoming_message";
import { MulticastGroupMessageHandler } from "./multicast_group/message_handler";
import { IncomingMessageMulticastGroup } from "./multicast_group/incoming_message";
import { EndpointMessageHandler } from "./endpoint/message_handler";
import { IncomingMessageEndpoint } from "./endpoint/incoming_message";

export class Client {
  public receiveEvents = false;
  private _outstandingPing = false;
  public schemaVersion = minSchemaVersion;
  public receiveLogs = false;

  private instanceHandlers: Record<
    Instance,
    (
      message: IncomingMessage
    ) => Promise<OutgoingMessages.OutgoingResultMessageSuccess["result"]>
  > = {
    [Instance.controller]: (message) =>
      ControllerMessageHandler.handle(
        message as IncomingMessageController,
        this.clientsController,
        this.driver,
        this
      ),
    [Instance.driver]: (message) =>
      DriverMessageHandler.handle(
        message as IncomingMessageDriver,
        this.clientsController,
        this.driver,
        this
      ),
    [Instance.node]: (message) =>
      NodeMessageHandler.handle(
        message as IncomingMessageNode,
        this.driver,
        this
      ),
    [Instance.multicast_group]: (message) =>
      MulticastGroupMessageHandler.handle(
        message as IncomingMessageMulticastGroup,
        this.driver
      ),
    [Instance.broadcast_node]: (message) =>
      BroadcastNodeMessageHandler.handle(
        message as IncomingMessageBroadcastNode,
        this.driver
      ),
    [Instance.endpoint]: (message) =>
      EndpointMessageHandler.handle(
        message as IncomingMessageEndpoint,
        this.driver
      ),
  };

  constructor(
    private socket: WebSocket,
    private clientsController: ClientsController,
    private driver: Driver,
    private logger: Logger
  ) {
    socket.on("pong", () => {
      this._outstandingPing = false;
    });
    socket.on("message", (data: string) => this.receiveMessage(data));
  }

  get isConnected(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  async receiveMessage(data: string) {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      // We don't have the message ID. Just close it.
      this.logger.debug(`Unable to parse data: ${data}`);
      this.socket.close();
      return;
    }

    try {
      if (msg.command === ServerCommand.setApiSchema) {
        // Handle schema version
        this.schemaVersion = msg.schemaVersion;
        if (
          this.schemaVersion < minSchemaVersion ||
          this.schemaVersion > maxSchemaVersion
        ) {
          throw new SchemaIncompatibleError(this.schemaVersion);
        }
        this.sendResultSuccess(msg.messageId, {});
        return;
      }

      if (msg.command === ServerCommand.startListening) {
        this.sendResultSuccess(
          msg.messageId,
          {
            state: dumpState(this.driver, this.schemaVersion),
          },
          true
        );
        this.receiveEvents = true;
        return;
      }

      if (msg.command === ServerCommand.updateLogConfig) {
        this.driver.updateLogConfig(msg.config);
        this.sendResultSuccess(msg.messageId, {});
        return;
      }

      if (msg.command === ServerCommand.getLogConfig) {
        this.sendResultSuccess(msg.messageId, {
          config: dumpLogConfig(this.driver, this.schemaVersion),
        });
        return;
      }

      const instance = msg.command.split(".")[0] as Instance;
      if (this.instanceHandlers[instance]) {
        return this.sendResultSuccess(
          msg.messageId,
          await this.instanceHandlers[instance](msg)
        );
      }

      throw new UnknownCommandError(msg.command);
    } catch (err: unknown) {
      if (err instanceof BaseError) {
        this.logger.error("Message error", err);
        const { errorCode, name, message, stack, ...args } = err;
        return this.sendResultError(msg.messageId, errorCode, args);
      }
      if (err instanceof ZWaveError) {
        this.logger.error("Z-Wave error", err);
        return this.sendResultZWaveError(msg.messageId, err.code, err.message);
      }

      this.logger.error("Unexpected error", err as Error);
      this.sendResultError(msg.messageId, ErrorCode.unknownError, {});
    }
  }

  sendVersion() {
    this.sendData({
      type: "version",
      driverVersion: libVersion,
      serverVersion: version,
      homeId: this.driver.controller.homeId,
      minSchemaVersion: minSchemaVersion,
      maxSchemaVersion: maxSchemaVersion,
    });
  }

  sendResultSuccess(
    messageId: string,
    result: OutgoingMessages.OutgoingResultMessageSuccess["result"],
    compress = false
  ) {
    this.sendData(
      {
        type: "result",
        success: true,
        messageId,
        result,
      },
      compress
    );
  }

  sendResultError(
    messageId: string,
    errorCode: Omit<ErrorCode, "zwaveError">,
    args: OutgoingMessages.JSONValue
  ) {
    this.sendData({
      type: "result",
      success: false,
      messageId,
      errorCode,
      args,
    });
  }

  sendResultZWaveError(
    messageId: string,
    zjsErrorCode: ZWaveErrorCodes,
    message: string
  ) {
    this.sendData({
      type: "result",
      success: false,
      messageId,
      errorCode: ErrorCode.zwaveError,
      zwaveErrorCode: zjsErrorCode,
      zwaveErrorMessage: message,
    });
  }

  sendEvent(event: OutgoingMessages.OutgoingEvent) {
    this.sendData({
      type: "event",
      event,
    });
  }

  sendData(data: OutgoingMessages.OutgoingMessage, compress = false) {
    this.socket.send(JSON.stringify(data), { compress });
  }

  checkAlive() {
    if (this._outstandingPing) {
      this.disconnect();
      return;
    }
    this._outstandingPing = true;
    this.socket.ping();
  }

  disconnect() {
    this.socket.close();
  }
}
export class ClientsController {
  public clients: Array<Client> = [];
  private pingInterval?: NodeJS.Timeout;
  private eventForwarder?: EventForwarder;
  private cleanupScheduled = false;
  private loggingEventForwarder?: LoggingEventForwarder;
  public grantSecurityClassesPromise?: DeferredPromise<InclusionGrant | false>;
  public validateDSKAndEnterPinPromise?: DeferredPromise<string | false>;

  constructor(public driver: Driver, private logger: Logger) {}

  addSocket(socket: WebSocket) {
    this.logger.debug("New client");
    const client = new Client(socket, this, this.driver, this.logger);
    socket.on("error", (error) => {
      this.logger.error("Client socket error", error);
    });
    socket.on("close", (code, reason) => {
      this.logger.info("Client disconnected");
      this.logger.debug(`Code ${code}: ${reason}`);
      this.scheduleClientCleanup();
    });
    client.sendVersion();
    this.clients.push(client);

    if (this.pingInterval === undefined) {
      this.pingInterval = setInterval(() => {
        const newClients = [];

        for (const client of this.clients) {
          if (client.isConnected) {
            newClients.push(client);
          } else {
            client.disconnect();
          }
        }

        this.clients = newClients;
      }, 30000);
    }

    if (this.eventForwarder === undefined) {
      this.eventForwarder = new EventForwarder(this);
      this.eventForwarder.start();
    }
  }

  get loggingEventForwarderStarted(): boolean {
    return this.loggingEventForwarder?.started === true;
  }

  public restartLoggingEventForwarderIfNeeded() {
    this.loggingEventForwarder?.restartIfNeeded();
  }

  public configureLoggingEventForwarder() {
    if (this.loggingEventForwarder === undefined) {
      this.loggingEventForwarder = new LoggingEventForwarder(
        this,
        this.driver,
        this.logger
      );
    }
    if (!this.loggingEventForwarderStarted) {
      this.loggingEventForwarder?.start();
    }
  }

  public cleanupLoggingEventForwarder() {
    if (
      this.clients.filter((cl) => cl.receiveLogs).length == 0 &&
      this.loggingEventForwarderStarted
    ) {
      this.loggingEventForwarder?.stop();
    }
  }

  private scheduleClientCleanup() {
    if (this.cleanupScheduled) {
      return;
    }
    this.cleanupScheduled = true;
    setTimeout(() => this.cleanupClients(), 0);
  }

  private cleanupClients() {
    this.cleanupScheduled = false;
    this.clients = this.clients.filter((cl) => cl.isConnected);
    this.cleanupLoggingEventForwarder();
  }

  disconnect() {
    if (this.pingInterval !== undefined) {
      clearInterval(this.pingInterval);
    }
    this.pingInterval = undefined;
    this.clients.forEach((client) => client.disconnect());
    this.clients = [];
    this.cleanupLoggingEventForwarder();
  }
}
interface ZwavejsServerOptions {
  port: number;
  logger?: Logger;
}

export interface Logger {
  error(message: string | Error, error?: Error): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export interface ZwavejsServer {
  start(): void;
  destroy(): void;
  on(event: "listening", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export class ZwavejsServer extends EventEmitter {
  private server?: HttpServer;
  private wsServer?: ws.Server;
  private sockets?: ClientsController;
  private logger: Logger;

  constructor(private driver: Driver, private options: ZwavejsServerOptions) {
    super();
    this.logger = options.logger ?? console;
  }

  async start() {
    if (!this.driver.ready) {
      throw new Error("Cannot start server when driver not ready");
    }

    this.server = createServer();
    this.wsServer = new ws.Server({
      server: this.server,
      perMessageDeflate: true,
    });
    this.sockets = new ClientsController(this.driver, this.logger);
    this.wsServer.on("connection", (socket) => this.sockets!.addSocket(socket));

    this.logger.debug(`Starting server on port ${this.options.port}`);

    this.server.on("error", this.onError.bind(this));
    this.server.listen(this.options.port);
    await once(this.server, "listening");
    this.emit("listening");
    this.logger.info(`ZwaveJS server listening on port ${this.options.port}`);
  }

  private onError(error: Error) {
    this.emit("error", error);
    this.logger.error(error);
  }

  async destroy() {
    this.logger.debug(`Closing server...`);
    if (this.sockets) {
      this.sockets.disconnect();
    }
    if (this.server) {
      this.server.close();
      await once(this.server, "close");
    }

    this.logger.info(`Server closed`);
  }
}
