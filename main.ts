import { $ } from "jsr:@david/dax";

export type CommandArgs = {
  name: string;
  fn: () => Promise<void | boolean>;
};

export class Command {
  name: string;
  fn: () => Promise<void | boolean>;

  constructor({ name, fn }: CommandArgs) {
    this.name = name;
    this.fn = fn;
  }
}

export class Check extends Command {}

export type ActionArgs = {
  name: string;
  preChecks: Check[];
  postChecks: Check[];
  command: Command;
  failFast: boolean;
};

export class Action {
  preChecks: Check[];
  command: Command;
  postChecks: Check[];
  name: string;
  failFast: boolean;

  constructor(
    { name, command, preChecks = [], postChecks = [], failFast = true }:
      ActionArgs,
  ) {
    this.name = name;
    this.preChecks = preChecks;
    this.command = command;
    this.postChecks = postChecks;
    this.failFast = failFast;
  }

  async runChecks(checks: Check[]) {
    const results = [];
    for (const check of checks) {
      const { name, fn } = check;
      const result = await fn();
      results.push({ name, result });
      if (result === false && this.failFast) {
        return { proceed: false, results };
      }
    }
    // TODO: check if this works for pre and post hooks
    if (results.length === 0) {
      return { proceed: false, results };
    }
    const result = results.every((r) => r.result);
    return { proceed: result, results };
  }

  async run() {
    $.logStep(`[${this.name}]`);
    await $.logGroup(async () => {
      const { proceed, results } = await this.runChecks(this.preChecks);
      $.logLight(`[Prechecks]`, { issues: proceed, results });
      if (!proceed) return;

      $.logError(`[Command]`, this.command.name);
      await this.command.fn();

      const r = await this.runChecks(this.postChecks);
      $.log(`[PostChecks]`, { ok: r.proceed, results: r.results });
      if (!proceed) throw new Error(`Action ${this.name} failed`);
    });
  }
}

export type ControllerArgs = {
  actions: Action[];
};

export class Controller {
  actions: Action[];

  constructor({ actions }: ControllerArgs) {
    this.actions = actions;
  }

  async run() {
    for (const action of this.actions) {
      await action.run().catch((e) => console.error(e));
    }
  }
}
