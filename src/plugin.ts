import { createServer, type Server } from "node:http";
import type { PluginContext } from "@weivel/typescript/context";
import { Catalog } from "./catalog.js";
import { LOG_LEVEL, WEIVEL_LOG } from "./kinds.js";
import { serve, type Proxy } from "./serve.js";
import type { Anthropic, Config, Log, LogLine, Paths, Provider, Routing } from "./services.js";
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

function logWriter(log: Log): (lines: readonly LogLine[] | undefined) => void {
  return (lines) => {
    for (const line of lines ?? []) {
      void log.write({ level: line.level === LOG_LEVEL.WARN ? WEIVEL_LOG.WARN : WEIVEL_LOG.INFO, message: line.message }).catch(() => undefined);
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
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error));
    server.listen(port, address, () => resolve(undefined));
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
  const settings = await readSettings(required<Config>(context, "weivel.config"), required<Paths>(context, "weivel.paths"));
  const writeLog = logWriter(required<Log>(context, "weivel.log"));
  const limits = await routing.limits({});
  const providers = (): Provider[] => context.capabilities.all(context.capability<Provider>(PROVIDER_CAPABILITY));
  const warn = (message: string): void => writeLog([{ level: LOG_LEVEL.WARN, message }]);
  const catalog = new Catalog({ providers, routing, profile: settings.profile, settings: settings.record, limits, warn, now: Date.now });
  const proxy: { -readonly [Key in keyof Proxy]: Proxy[Key] } = { routing, anthropic, settings, port: 0, limits, catalog, writeLog };
  const server = createServer((incoming, response) => void serve(proxy, incoming, response));
  try {
    proxy.port = await listening(routing, settings, server);
  } catch (error) {
    catalog.stop();
    warn(error instanceof Error ? error.message : String(error));
    throw error;
  }
  return { server, catalog };
}

function stopped(stopping: Running): Promise<void> {
  stopping.catalog.stop();
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
