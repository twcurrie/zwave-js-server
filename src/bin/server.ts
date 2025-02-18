#!/usr/bin/env node
import { resolve } from "path";
import { Driver, ZWaveError, ZWaveErrorCodes } from "zwave-js";
import { ZwavejsServer } from "../lib/server";
import { createMockDriver } from "../mock";
import { parseArgs } from "../util/parse-args";

const normalizeKey = (key: Buffer | string, keyName: string): Buffer => {
  if (Buffer.isBuffer(key)) return key;
  if (key.length === 32) return Buffer.from(key, "hex");
  // Convert from OpenZWave format
  key = key.toLowerCase();
  if (key.includes("0x"))
    return Buffer.from(key.replace(/0x/g, "").replace(/, /g, ""), "hex");
  throw new Error(`Invalid key format for ${keyName} option`);
};

interface Args {
  _: Array<string>;
  config?: string;
  "mock-driver": boolean;
  port: number;
}

(async () => {
  const args = parseArgs<Args>(["_", "config", "mock-driver", "port"]);

  let wsPort = 3000;
  if (args["port"]) {
    if (typeof args["port"] !== "number") {
      throw new Error("port must be a valid integer");
    }
    wsPort = args["port"];
  }

  if (args["mock-driver"]) {
    args._.push("mock-serial-port");
  }

  if (args._.length < 1) {
    console.error("Error: Missing path to serial port");
    return;
  }

  const serialPort = args._[0];

  let configPath = args.config;
  if (configPath && configPath.substring(0, 1) !== "/") {
    configPath = resolve(process.cwd(), configPath);
  }

  let options;

  if (configPath) {
    try {
      options = require(configPath);
      // If both securityKeys.S0_Legacy and networkKey are defined, throw an error.
      if (options.securityKeys?.S0_Legacy && options.networkKey) {
        throw new Error(
          "Both `networkKey` and `securityKeys.S0_Legacy` options are present in the " +
            "config. Remove `networkKey`."
        );
      }
      const securityKeyNames = [
        "S0_Legacy",
        "S2_AccessControl",
        "S2_Authenticated",
        "S2_Unauthenticated",
      ];
      // We prefer the securityKeys option over the networkKey one
      if (options.securityKeys) {
        for (const key of securityKeyNames) {
          if (key in options.securityKeys) {
            options.securityKeys[key] = normalizeKey(
              options.securityKeys[key],
              `securityKeys.${key}`
            );
          }
        }
      }
      // If we get here, securityKeys.S0_Legacy is not defined, so we can safely use networkKey
      // make sure that networkKey is passed as buffer and accept both zwave2mqtt format and ozw format
      if (options.networkKey) {
        if (!options.securityKeys) options.securityKeys = {};
        options.securityKeys.S0_Legacy = normalizeKey(
          options.networkKey,
          "networkKey"
        );
        console.warn(
          "The `networkKey` option is deprecated in favor of `securityKeys` option. To eliminate " +
            "this warning, move your networkKey into the securityKeys.S0_Legacy option. Refer to " +
            "the Z-Wave JS docs for more information"
        );
        delete options.networkKey;
      } else if (!options.networkKey && !options.securityKeys.S0_Legacy)
        throw new Error("Error: `securityKeys.S0_Legacy` key is missing.");
    } catch (err) {
      console.error(`Error: failed loading config file ${configPath}`);
      console.error(err);
      return;
    }
  }

  const driver = args["mock-driver"]
    ? createMockDriver()
    : new Driver(serialPort, options);

  driver.on("error", (e) => {
    console.error("Error in driver", e);
    // Driver_Failed cannot be recovered by zwave-js so we shut down
    if (e instanceof ZWaveError && e.code === ZWaveErrorCodes.Driver_Failed) {
      handleShutdown(1);
    }
  });

  let server: ZwavejsServer;

  driver.on("driver ready", async () => {
    try {
      server = new ZwavejsServer(driver, { port: wsPort });
      await server.start();
      console.info("Server listening on port", wsPort);
    } catch (error) {
      console.error("Unable to start Server", error);
    }
  });

  await driver.start();

  let closing = false;

  const handleShutdown = async (exitCode = 0) => {
    // Pressing ctrl+c twice.
    if (closing) {
      process.exit(exitCode);
    }

    // Close gracefully
    closing = true;
    console.log("Shutting down");
    if (server) {
      await server.destroy();
    }
    if (driver) {
      await driver.destroy();
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
})().catch((err) => {
  console.error("Unable to start driver", err);
  process.exit(1);
});
