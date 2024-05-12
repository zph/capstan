#!/usr/bin/env deno run --unstable-kv -A

import { $ } from "jsr:@david/dax";

import { Action, ActionArgs, Check, Command, Controller } from "../../main.ts";

const KV = await Deno.openKv();

//const DESIRED_VERSION = "3.4.25"
//const DESIRED_VERSION = "3.6.23"
//const DESIRED_VERSION = "4.0.28"
//const DESIRED_VERSION = "4.2.25"
const DESIRED_VERSION = "4.4.29";
//const DESIRED_VERSION = "5.0.26"
//const DESIRED_VERSION = "6.0.15"

type NodeState = "running" | "stopped" | "unknown";
type NodeType = "mongod" | "mongos";
class Node {
  name: string;
  port: number;
  state: NodeState;
  node_type: NodeType;
  DESIRED_VERSION: string;

  constructor(
    { name, state, port, node_type, DESIRED_VERSION }: {
      name: string;
      state: NodeState;
      port: number;
      node_type: NodeType;
      DESIRED_VERSION: string;
    },
  ) {
    this.name = name;
    this.state = state;
    this.port = port;
    this.node_type = node_type;
    this.DESIRED_VERSION = DESIRED_VERSION;
  }

  async version() {
    const raw = await this.#mongo("db.version()");
    const version = raw.replaceAll('"', "");
    const rs = await this.shardName();
    await KV.set(["shards", rs, this.name, "version"], version);
    return version;
  }

  async online(): Promise<boolean> {
    await this.updateStatus();
    return this.state === "running";
  }

  async rs_status() {
    return JSON.parse(await this.#mongo("rs.status()"));
  }

  async status() {
    return await this.rs_status();
  }
  async role() {
    return JSON.parse(await this.#mongo("rs.status()")).members.find((v) =>
      v.self
    ).stateStr;
  }

  async shardName() {
    if (this.node_type === "mongod") {
      return (await this.rs_status())["set"];
    } else {
      return "mongos";
    }
  }

  async getFeatureControlVersion() {
    const response = JSON.parse(
      await this.#mongo(
        `db.adminCommand({getParameter: 1, featureCompatibilityVersion: 1})`,
      ),
    );
    return response.featureCompatibilityVersion.version;
  }

  async upgradeFeatureControlVersion(mongod: Node) {
    const fcv = this.DESIRED_VERSION.split(".").slice(0, 2).join(".");
    const currentVersion = await mongod.getFeatureControlVersion();
    if (currentVersion === fcv) {
      console.log(`Already on correct fcv`);
      return;
    }
    const r = await confirm(
      `Are you sure you want to set fcv: ${fcv} from ${currentVersion}`,
    );
    if (!r) {
      console.log(`Refused upgrade, skipping`);
      return;
    }
    await this.#mongo(
      `db.adminCommand({ setFeatureCompatibilityVersion: '${fcv}' })`,
    );
  }

  // TODO: rework this to use plain binary and the --binarypath flag
  async stop() {
    await $.raw`./bin/mlaunch stop ${this.node_type} ${this.port}`.env({
      MONGO_VERSION: this.DESIRED_VERSION,
    });
  }

  async start() {
    await $.raw`./bin/mlaunch start ${this.node_type} ${this.port}`.env({
      MONGO_VERSION: this.DESIRED_VERSION,
    });
  }

  async stepDown() {
    await this.#mongo("rs.stepDown()");
  }

  async requiresFailoverToUpgrade() {
    if (await this.role() !== "PRIMARY") return false;
    if (await this.version() === this.DESIRED_VERSION) return false;
    const rs = await this.shardName();
    const vx = await KV.list({ prefix: ["shards", rs] });
    const versions: string[] = [];
    for await (const entry of vx) {
      if (entry.key[2] === this.name) continue;
      versions.push(entry.value as string);
    }
    console.log(`Versions: `, versions);
    if (versions.length === 0) return false;
    // Check member count
    const peerCount = (await this.rs_status()).members.length - 1; // removing self
    if (peerCount != Object.keys(versions).length) return false;
    if (versions.every((v) => v === this.DESIRED_VERSION)) return true;
  }

  async updateStatus() {
    const processes = await new Processes().load();
    const mongod = processes.find((p) =>
      p.command.includes(this.node_type) && p.command.includes(`${this.port}`)
    );
    try {
      if (mongod) {
        this.state = "running";
      } else {
        this.state = "stopped";
      }
    } catch (_) {
      this.state = "unknown";
    }
  }
  async #mongo(cmd: string) {
    return (await $
      .raw`mongo --quiet mongodb://localhost:${this.port} --eval "print(JSON.stringify(${cmd}))"`
      .text()).split("\n").filter((v) => !v.match("machdep.cpu"))?.join("\n");
  }
}

class Processes {
  async load() {
    const raw = await $`ps -eo user,pid,lstart,command`.text();
    // Filter out last process result which is the final newline
    return raw.split("\n").slice(1).map(this.processLine).filter((p) =>
      p.command
    );
  }

  processLine = (line: string) => {
    const [user, pid_and_date, command] = line.split(/\s{4,}/g);
    const [pid, ...date] = pid_and_date.split(/\s+/g);
    return new Process({
      user,
      command,
      pid: parseInt(pid),
      date: new Date(Date.parse(date.join(" "))),
    });
  };
}

type ProcessArgs = {
  user: string;
  command: string;
  pid: number;
  date: Date;
};

class Process {
  public user: string;
  public command: string;
  public pid: number;
  public date: Date;

  constructor({ user, command, pid, date }: ProcessArgs) {
    this.command = command;
    this.user = user;
    this.pid = pid;
    this.date = date;
  }
}

while (true) {
  const buildNotVersionCheck = (n: Node) =>
    new Check({
      name: `[${n.name}] mongo version needs changed to ${n.DESIRED_VERSION}`,
      fn: async () => {
        const v = await n.version();
        return v !== n.DESIRED_VERSION;
      },
    });

  const isSecondaryCheck = (n: Node) =>
    new Check({
      name: `[${n.name}] mongo is secondary`,
      fn: async () => {
        const v = await n.role();
        return v === "SECONDARY";
      },
    });

  const isPrimaryCheck = (n: Node) =>
    new Check({
      name: `[${n.name}] mongo is primary`,
      fn: async () => {
        const v = await n.role();
        return v === "PRIMARY";
      },
    });

  const isOnlineCheck = (n: Node) =>
    new Check({
      name: `[${n.name}] mongo is online`,
      fn: async () => {
        const v = await n.online();
        return v;
      },
    });

  const buildIsVersionCheck = (n: Node) =>
    new Check({
      name: `[${n.name}] mongo version is ${n.DESIRED_VERSION}`,
      fn: async () => {
        const v = await n.version();
        return v === n.DESIRED_VERSION;
      },
    });

  const buildInHealthyReplicaCheck = (n: Node) =>
    new Check({
      name: `[${n.name}] mongod in a healthy replicaset`,
      fn: async () => {
        const states = (await n.rs_status()).members.map((m) => m.stateStr);
        return (
          states.every((s) => ["PRIMARY", "SECONDARY"].includes(s)) &&
          [1, 3, 5].includes(states.length)
        );
      },
    });

  const upgradeMongoCommand = (n: Node) =>
    new Command({
      name: "change mongo version",
      fn: async () => {
        await $`./bin/mlaunch stop ${n.node_type} ${n.port}`.env({
          MONGO_VERSION: n.DESIRED_VERSION,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await $`./bin/mlaunch start ${n.node_type} ${n.port}`.env({
          MONGO_VERSION: n.DESIRED_VERSION,
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      },
    });

  const buildUpgradeMongodAction = (n: Node, configServers: Node[]) =>
    new Action({
      name: `[${n.name}] upgrade mongo to ${n.DESIRED_VERSION}`,
      preChecks: [
        isOnlineCheck(n),
        isSecondaryCheck(n),
        buildNotVersionCheck(n),
        buildInHealthyReplicaCheck(n),
        ...[...configServers].map(buildIsVersionCheck),
      ],
      command: upgradeMongoCommand(n),
      postChecks: [
        buildInHealthyReplicaCheck(n),
        buildIsVersionCheck(n),
      ],
    } as ActionArgs);

  const buildUpgradeConfigServerAction = (n: Node) =>
    new Action({
      name: `[${n.name}] upgrade mongo to ${n.DESIRED_VERSION}`,
      preChecks: [
        isOnlineCheck(n),
        isSecondaryCheck(n),
        buildNotVersionCheck(n),
        buildInHealthyReplicaCheck(n),
      ],
      command: upgradeMongoCommand(n),
      postChecks: [
        buildInHealthyReplicaCheck(n),
        buildIsVersionCheck(n),
      ],
    } as ActionArgs);

  const buildUpgradeMongosAction = (n: Node, nodes: Node[]) =>
    new Action({
      name: `[${n.name}] upgrade mongos to ${n.DESIRED_VERSION}`,
      preChecks: [
        isOnlineCheck(n),
        buildNotVersionCheck(n),
        ...nodes.map(buildIsVersionCheck),
      ],
      command: upgradeMongoCommand(n),
      postChecks: [
        buildIsVersionCheck(n),
      ],
    } as ActionArgs);

  const isMongoOnline = (n: Node) =>
    new Check({
      name: `check if mongo is online`,
      fn: async () => {
        const online = await n.online().catch((_) => false);
        return online;
      },
    });

  const startServersAction = (n: Node) =>
    new Action({
      name: `[${n.name}] start mongo`,
      // TODO: consider adding a negate for checks?
      // TODO: consider adding a confirm step before actions run
      preChecks: [
        new Check({
          name: `check if mongo is offline`,
          fn: async () => {
            const online = await n.online().catch((_) => false);
            return !online;
          },
        }),
      ],
      command: new Command({
        name: `start mongo`,
        fn: async () => await n.start().catch(console.error),
      }),
      postChecks: [
        isMongoOnline(n),
      ],
    } as ActionArgs);

  const nodes = [...Array(9).keys()].map((i) => i + 27020).map((port) =>
    new Node({
      "name": `mongod:${port}`,
      "node_type": "mongod",
      "state": "unknown",
      port,
      DESIRED_VERSION,
    })
  );

  const configServers = [...Array(3).keys()].map((i) => i + 27029).map((port) =>
    new Node({
      "name": "config-server:" + port,
      "node_type": "mongod",
      "state": "unknown",
      port,
      DESIRED_VERSION,
    })
  );

  const mongoses = [...Array(3).keys()].map((i) => i + 27017).map((port) =>
    new Node({
      "name": `mongos:${port}`,
      "node_type": "mongos",
      "state": "unknown",
      port,
      DESIRED_VERSION,
    })
  );

  const buildFailoverToUpgrade = (n: Node) =>
    new Action({
      name: `failover to upgrade ${n.name}`,
      preChecks: [
        isMongoOnline(n),
        isPrimaryCheck(n),
        new Check({
          name: `is mongod type instance`,
          fn: async () => await n.node_type === "mongod",
        }),
        buildInHealthyReplicaCheck(n),
        buildNotVersionCheck(n),
        new Check({
          name: `last member in rs to upgrade`,
          fn: async () => {
            return await n.requiresFailoverToUpgrade();
          },
        }),
      ],
      command: new Command({
        name: `failing over ${n.name}`,
        fn: async () => {
          const response = confirm(`May I failover ${n.name}?`);
          if (response) {
            await n.stepDown();
          }
        },
      }),
      postChecks: [
        isMongoOnline(n),
      ],
    });

  const UpgradeFeatureControlVersionAction = (mongod: Node, mongos: Node[]) =>
    new Action({
      name: `upgrade feature control version to ${mongos[0].DESIRED_VERSION}`,
      preChecks: [
        ...mongos.map(isMongoOnline),
        ...mongos.map(buildIsVersionCheck),
      ],
      command: new Command({
        name: `upgrade feature control version`,
        fn: async () => {
          const response = confirm(`May I upgrade feature control version?`);
          if (response) {
            await mongos[0].upgradeFeatureControlVersion(mongod);
          }
        },
      }),
      postChecks: [
        ...mongos.map(isMongoOnline),
      ],
    });

  const configServerUpgrades = configServers.map(
    buildUpgradeConfigServerAction,
  );
  const mongodUpgrades = nodes.map((n) =>
    buildUpgradeMongodAction(n, configServers)
  );
  const mongosUpgrades = mongoses.map((n) =>
    buildUpgradeMongosAction(n, [...configServers, ...nodes])
  );
  const startServers = [...nodes, ...configServers, ...mongoses].map(
    startServersAction,
  );

  const actions = [
    ...startServers,
    ...configServerUpgrades,
    ...configServers.map(buildFailoverToUpgrade),
    ...configServerUpgrades,
    ...mongodUpgrades,
    ...nodes.map(buildFailoverToUpgrade),
    ...mongodUpgrades,
    ...mongosUpgrades,
    UpgradeFeatureControlVersionAction(nodes[0], mongoses),
  ];

  await new Controller({ actions }).run();

  await new Promise((resolve) => setTimeout(resolve, 10000));
}
