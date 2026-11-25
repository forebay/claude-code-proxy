import { createServer, type Server } from "node:http";
import type { PluginContext } from "@weivel/typescript/context";
import { Catalog } from "./catalog.js";
import { serve, type Proxy } from "./serve.js";
import { ANTHROPIC_ENUM_NAMES, LOG_ENUM_NAMES, PROVIDER_ENUM_NAMES, ROUTING_ENUM_NAMES, type Anthropic, type Config, type Enums, type Log, type LogLine, type Provider, type Routing } from "./services.js";
import { readSettings, type ProxySettings } from "./settings.js";

const PROVIDER_CAPABILITY = "forebay.provider";

interface Running {
  readonly server: Server;
  readonly catalog: Catalog;
}

function required<Service>(context: PluginContext, id: string): Service {
  const service = context.services.get(context.service<Service>(id));
  if (service === undefined) throw new Error(`claude-code-proxy reaches no ${id} service`);
  return service;
}

/**
 * Every enum entry this plugin reads, from the descriptions of what it reaches, refusing the activation when one lacks a
 * name it reads.
 *
 * @implNote They are read once, at the activation, which holds because a header's enums are append-only: an entry never
 * changes its number while the plugin runs.
 */
function enumsOf(context: PluginContext, reached: { routing: Routing; anthropic: Anthropic; log: Log }): Enums {
  const { services, capabilities } = context;
  return {
    routing: context.requireEnums(services.enumsOf(reached.routing), ROUTING_ENUM_NAMES, "routing"),
    anthropic: context.requireEnums(services.enumsOf(reached.anthropic), ANTHROPIC_ENUM_NAMES, "anthropic"),
    provider: context.requireEnums(capabilities.enumsOf(context.capability(PROVIDER_CAPABILITY)), PROVIDER_ENUM_NAMES, PROVIDER_CAPABILITY),
    log: context.requireEnums(services.enumsOf(reached.log), LOG_ENUM_NAMES, "weivel.log"),
  };
}

function logWriter(log: Log, enums: Enums): (lines: readonly LogLine[]) => void {
  const { FOREBAY_LOG_WARN } = enums.routing.forebay_log_level;
  const { WEIVEL_STANDARD_LOG_INFO, WEIVEL_STANDARD_LOG_WARN } = enums.log.weivel_standard_log_level;
  return (lines) => {
    for (const line of lines) {
      void log.write({ level: line.level === FOREBAY_LOG_WARN ? WEIVEL_STANDARD_LOG_WARN : WEIVEL_STANDARD_LOG_INFO, message: line.message }).catch(() => undefined);
    }
  };
}

async function refusalAsError<Answer>(call: Promise<Answer>): Promise<Answer> {
  try {
    return await call;
  } catch (error) {
    const { detail, fix } = error as { detail?: string | null; fix?: string | null };
    if (typeof detail === "string") throw new Error(typeof fix === "string" ? `${detail}; fix: ${fix}` : detail, { cause: error });
    throw error;
  }
}

function listened(server: Server, port: number, address: string): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const failed = (error: NodeJS.ErrnoException): void => resolve(error);
    server.once("error", failed);
    server.listen(port, address, () => {
      server.off("error", failed);
      resolve(undefined);
    });
  });
}

/** Listens where C's `port` answers for the setting; a listen that fails is refused in C's words. */
async function listening(routing: Routing, settings: ProxySettings, server: Server): Promise<number> {
  const argument = { value: settings.port, settings_file: settings.settingsFile };
  const { port, address } = await refusalAsError(routing.port({ argument }));
  const error = await listened(server, port, address);
  if (error === undefined) return port;
  const failure = { in_use: error.code === "EADDRINUSE" ? 1 : 0, detail: error.message };
  await refusalAsError(routing.port({ argument: { ...argument, failure } }));
  throw error;
}

async function started(context: PluginContext): Promise<Running> {
  const routing = required<Routing>(context, "routing");
  const anthropic = required<Anthropic>(context, "anthropic");
  const log = required<Log>(context, "weivel.log");
  const enums = enumsOf(context, { routing, anthropic, log });
  const settings = await readSettings(required<Config>(context, "weivel.config"));
  const providerType = context.capability<Provider>(PROVIDER_CAPABILITY);
  const writeLog = logWriter(log, enums);
  const limits = await routing.limits({});
  const providers = (): Provider[] => context.capabilities.all(providerType);
  const catalog = await Catalog.opened({ providers, routing, enums: enums.routing, profile: settings.profile, settings: settings.record, writeLog, now: Date.now });
  const proxy: { -readonly [Key in keyof Proxy]: Proxy[Key] } = { routing, anthropic, enums, settings, port: 0, limits, catalog, writeLog };
  const server = createServer((incoming, response) => void serve(proxy, incoming, response));
  try {
    proxy.port = await listening(routing, settings, server);
  } catch (error) {
    catalog.release();
    throw error;
  }
  return { server, catalog };
}

function stopped(stopping: Running): Promise<void> {
  stopping.catalog.release();
  return new Promise((resolve) => {
    stopping.server.close(() => resolve());
    stopping.server.closeAllConnections();
  });
}

function proxyPlugin(): { activate(context: PluginContext): Promise<void>; deactivate(): Promise<void> } {
  let running: Running | undefined;
  return {
    async activate(context) {
      running = await started(context);
    },
    async deactivate() {
      const stopping = running;
      running = undefined;
      if (stopping !== undefined) await stopped(stopping);
    },
  };
}

export default proxyPlugin();
