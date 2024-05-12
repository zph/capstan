# Capstan

![](.config/assets/capstan.jpg)

Capstan is a framework for running a series of actions with pre-checks and
post-checks. It defines three main classes: `Command`, `Action`, and
`Controller`.

> Capstan's goal is to reduce the human labor and errors involved in safety
> checks when performing major changes to complex systems such as
> infrastructure, while being generic enough to be used in any environment.

See [examples](examples/mongo-upgrade/README.md) for a full example.

## Usage

To use this framework, you will create instances of the `Command`, `Check`,
`Action`, and `Controller` classes, and then call the `run()` method of the
`Controller` instance.

For example:

```typescript
import { Action, Check, Command, Controller } from "./main.ts";

// Define commands
const Command = new Command({
  name: "My Command",
  fn: async () => {
    console.log("Executing my command...");
    // Perform some operation
    return true;
  },
});

// Define checks
const PreCheck = new Check({
  name: "My Pre-check",
  fn: async () => {
    console.log("Checking pre-condition...");
    // Perform some check and return true if the command should run
    return true;
  },
});

const PostCheck = new Check({
  name: "My Post-check",
  fn: async () => {
    console.log("Checking post-condition...");
    // Perform some check and return true if checks are successful
    return true;
  },
});

// Define an action
const ExampleAction = new Action({
  name: "My Action",
  command: Command,
  preChecks: [PreCheck],
  postChecks: [PostCheck],
  failFast: true,
});

// Create a controller and run the action
const controller = new Controller({
  actions: [ExampleAction],
});

await controller.run();
```

In this example, we define a command (`myCommand`), two checks (`myPreCheck` and
`myPostCheck`), and an action (`myAction`) that includes the command and checks.
We then create a `Controller` instance with the action and call its `run()`
method to execute the action.

## Components

### Command

The `Command` class represents a single command or task to be executed. It has
two properties:

- `name`: A string representing the name of the command.
- `fn`: A function that returns a Promise, which is the actual command to be
  executed.

### Check

The `Check` class extends the `Command` class and is used to define pre-checks
and post-checks for an action.

### Action

The `Action` class represents a single action that consists of pre-checks, a
command, and post-checks. It has the following properties:

- `preChecks`: An array of `Check` objects representing the pre-checks to be
  executed before the command.
- `command`: A `Command` object representing the main command to be executed.
- `postChecks`: An array of `Check` objects representing the post-checks to be
  executed after the command.
- `name`: A string representing the name of the action.
- `failFast`: A boolean indicating whether the action should stop executing if
  any pre-check or post-check fails.

The `Action` class has two main methods:

1. `runChecks(checks: Check[])`: This method executes an array of checks and
   returns an object containing a boolean `proceed` property indicating whether
   all checks passed, and a `results` array containing the results of each
   check.

2. `run()`: This method executes the entire action. It first runs the
   pre-checks, then the main command, and finally the post-checks. If any
   pre-check or post-check fails and `failFast` is set to `true`, the action
   stops executing.

### Controller

The `Controller` class manages the execution of multiple actions. It has the
following property:

- `actions`: An array of `Action` objects representing the actions to be
  executed.

The `Controller` class has a single method:

- `run()`: This method iterates over the `actions` array and executes each
  action using the `run()` method of the `Action` class. If an action fails, an
  error is logged to the console.
