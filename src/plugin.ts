import type { Plugin } from "@weivel/typescript";
import type { FrontDoor } from "@forebay/host";
import { frontDoor } from "./front-door.js";

const plugin: Plugin = {
  activate(context) {
    const upstream = context.config.get<string>("upstream");
    if (upstream === undefined) throw new Error("the upstream setting is missing from claude-code-proxy's configuration");
    context.provide(context.capability<FrontDoor>("front-door"), frontDoor(upstream));
  },
  deactivate() {},
};

export default plugin;
