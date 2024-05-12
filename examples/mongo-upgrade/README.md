# MongoDB Upgrade Automation

Toy demonstration of using `capstan` for automating MongoDB upgrades.

This Git repository contains a Deno script (`./examples/mongo-upgrade/main.ts`) that automates the process of upgrading a MongoDB cluster to a desired version. The script is designed to handle various scenarios, including upgrading config servers, sharded cluster nodes (mongod), and mongos instances, while ensuring the cluster remains operational throughout the upgrade process.

## Prerequisites

Before running the script, ensure you have the following prerequisites:

1. Deno installed on your system. You can install it from the official website: [https://deno.land/](https://deno.land/)
2. A MongoDB cluster set up and running using mlaunch from `zph/mongo-scaffold`, with the necessary configuration files and data directories in place.
3. The `mlaunch` utility installed and available in the `./bin` directory relative to the script location in order to allow for shimming in the desired version onto mlaunch's path

## Usage

1. Clone the repository: `git clone https://github.com/zph/capstan.git`
2. Navigate to the project directory: `cd repo/examples/mongo-upgrades`
3. Replace `const DESIRED_VERSION = "4.4.29"` with the desired MongoDB version you want to upgrade to.
4. Run the script

`deno run --unstable-kv -A mainup.ts`

The script will perform the following actions:

1. Start any stopped MongoDB instances.
2. Upgrade the config servers one by one, ensuring a healthy replica set state, and performing failovers if necessary.
3. Upgrade the sharded cluster nodes (mongod) one by one, performing failovers if necessary.
4. Upgrade the mongos instances.
5. Update the feature compatibility version (FCV) to match the desired version.

During the upgrade process, the script will prompt for confirmation before performing certain critical operations, such as failovers or FCV updates.
