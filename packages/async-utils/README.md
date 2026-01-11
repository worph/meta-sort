# Async Utils

A TypeScript library providing utility classes and functions to simplify working with asynchronous operations and promises.

## Installation

```bash
yarn add github:worph/async-utils#main
```

## Features

- **Lazy<T>**: A utility type for lazy initialization of asynchronous operations.
- **ListenerCleaner**: Manages cleanup functions, allowing for easy resource management.
- **PromiseQueue**: A queue system for promises, allowing for sequential execution and cancellation.
- **MultiQueue**: Manages multiple `PromiseQueue` instances, distributing tasks to optimize concurrency.
- **Id Generation**: Utility function for generating random IDs.

## Usage

### Lazy Initialization

```typescript
import { Lazy } from "@worph/async-utils";

const lazyValue: Lazy<number> = async () => {
  // some asynchronous operation
  return 42;
};

// Usage
lazyValue().then(value => console.log(value));
```

### Listener Cleaner

```typescript
import { ListenerCleaner } from "worph/async-utils";

const cleaner = new ListenerCleaner();
cleaner.add(() => console.log("Cleanup action"));

// Trigger all cleanup actions
cleaner.cleanUp();
```

### Promise Queue

```typescript
import { PromiseQueue } from "@worph/async-utils";

const queue = new PromiseQueue<number>();

queue.add(async () => {
  // some asynchronous task
  return 1;
});

// Wait for the queue to be empty
queue.awaitQueueEmpty().then(() => console.log("Queue empty"));
```

### Multi Queue

```typescript
import { MultiQueue } from "@worph/async-utils";

const multiQueue = new MultiQueue<number>(2); // 2 concurrent tasks

multiQueue.add(async () => {
  // some asynchronous task
  return 1;
});

// Add more tasks...

// Wait for all queues to be empty
multiQueue.awaitQueueEmpty().then(() => console.log("All queues empty"));
```

### Generating an ID

```typescript
import { makeid } from "@worph/async-utils";

const id = makeid(10); // Generates a random 10 character string
console.log(id);
```

## Contributing

Contributions are welcome! Please submit a pull request or open an issue for discussion.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
