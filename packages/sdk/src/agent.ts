import { Browsers, type RuntimeConnector } from "./browsers.js";
import { renderHelp } from "./help.js";

export class Agent {
  readonly browsers: Browsers;

  constructor(connector: RuntimeConnector) {
    this.browsers = new Browsers(connector);
  }

  help(): string {
    return renderHelp();
  }
}
