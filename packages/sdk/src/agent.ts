import { Browsers, type RuntimeConnector } from "./browsers.js";
import type { Guards } from "./guards.js";
import { renderHelp } from "./help.js";

export type AgentOptions = {
  guards?: Guards;
};

export class Agent {
  readonly browsers: Browsers;

  constructor(connector: RuntimeConnector, opts: AgentOptions = {}) {
    this.browsers = new Browsers(connector, opts.guards);
  }

  help(): string {
    return renderHelp();
  }
}
