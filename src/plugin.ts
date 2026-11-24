import { createServer, type Server } from "node:http";
import type { DescribedEnums, PluginContext } from "@weivel/typescript/context";
import { Catalog } from "./catalog.js";
import { serve, type Proxy } from "./serve.js";
import type { Anthropic, Config, Enums, Log, LogLine, Provider, Routing } from "./services.js";
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

/** The enums a description carries, read as the names this plugin reads of them. */
function described<Read>(enums: DescribedEnums | undefined, of: string): Read {
  if (enums === undefined) throw new Error(`claude-code-proxy reads the enums of ${of}, and no description carries them`);
  return enums as unknown as Read;
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
  const settings = await readSettings(required<Config>(context, "weivel.config"));
  const log = required<Log>(context, "weivel.log");
  const providerType = context.capability<Provider>(PROVIDER_CAPABILITY);
  const enums: Enums = {
    routing: described(context.services.enumsOf(routing), "routing"),
    anthropic: described(context.services.enumsOf(anthropic), "anthropic"),
    provider: described(context.capabilities.enumsOf(providerType), PROVIDER_CAPABILITY),
    log: described(context.services.enumsOf(log), "weivel.log"),
  };
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
