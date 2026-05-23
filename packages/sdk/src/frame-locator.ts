import { Guards, type CommandabilityGuard } from "./guards.js";
import { attrSelector, Locator, roleSelector, testIdSelector, textSelector } from "./locator.js";
import type { Transport } from "./wire/transport.js";

type TextMatcher = string | RegExp;

export class FrameLocator {
  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    private readonly tabId: string,
    private readonly frameSelector: string,
    private readonly ensureCommandable?: CommandabilityGuard,
  ) {}

  locator(selector: string): Locator {
    if (!selector) throw new Error("frameLocator.locator requires a selector");
    return new Locator(
      this.transport,
      this.guards,
      this.tabId,
      `${this.frameSelector} >> internal:control=enter-frame >> ${selector}`,
      this.ensureCommandable,
    );
  }

  frameLocator(selector: string): FrameLocator {
    if (!selector) throw new Error("frameLocator.frameLocator requires a selector");
    return new FrameLocator(
      this.transport,
      this.guards,
      this.tabId,
      `${this.frameSelector} >> internal:control=enter-frame >> ${selector}`,
      this.ensureCommandable,
    );
  }

  getByRole(role: string, opts: { name?: TextMatcher; exact?: boolean } = {}): Locator {
    return this.locator(roleSelector(role, opts));
  }

  getByText(text: TextMatcher, opts: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:text=${textSelector(text, !!opts.exact)}`);
  }

  getByLabel(text: TextMatcher, opts: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:label=${textSelector(text, !!opts.exact)}`);
  }

  getByPlaceholder(text: TextMatcher, opts: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:attr=[placeholder=${attrSelector(text, !!opts.exact)}]`);
  }

  getByTestId(testId: string): Locator {
    return this.locator(testIdSelector(testId));
  }
}
