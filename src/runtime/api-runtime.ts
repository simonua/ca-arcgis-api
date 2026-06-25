import type { CollectionSchedulerRunner } from '../harvesting/collection-scheduler-runner.ts';
import type { ApiRequestContext, ApiRequestHandler } from '../http/api-handler.ts';

export interface ApiRuntimeServer {
  readonly finished: Promise<void>;
  shutdown(): Promise<void>;
}

export interface ApiRuntimeServerFactory {
  start(handler: ApiRequestHandler): ApiRuntimeServer;
}

export interface ApiRuntime {
  start(): void;
  stop(): Promise<void>;
  finished(): Promise<void>;
}

export interface ApiRuntimeDependencies {
  readonly handler: ApiRequestHandler;
  readonly serverFactory: ApiRuntimeServerFactory;
  readonly schedulerRunner?: CollectionSchedulerRunner;
}

/** Owns server and scheduler ordering with idempotent startup and shutdown. */
export function createApiRuntime(dependencies: ApiRuntimeDependencies): ApiRuntime {
  let server: ApiRuntimeServer | undefined;
  let stopping: Promise<void> | undefined;

  return Object.freeze({
    start(): void {
      if (server !== undefined || stopping !== undefined) {
        return;
      }
      server = dependencies.serverFactory.start(dependencies.handler);
      dependencies.schedulerRunner?.start();
    },

    stop(): Promise<void> {
      if (stopping !== undefined) {
        return stopping;
      }
      dependencies.schedulerRunner?.stop();
      stopping = server === undefined ? Promise.resolve() : server.shutdown();
      return stopping;
    },

    finished(): Promise<void> {
      return server?.finished ?? Promise.resolve();
    },
  });
}

export interface DenoHttpServerFactoryOptions {
  readonly hostname: string;
  readonly port: number;
}

/** Adapts Deno's socket boundary while preserving a permission-free handler for tests. */
export function createDenoHttpServerFactory(
  options: DenoHttpServerFactoryOptions,
): ApiRuntimeServerFactory {
  return Object.freeze({
    start(handler: ApiRequestHandler): ApiRuntimeServer {
      const server = Deno.serve(
        {
          hostname: options.hostname,
          port: options.port,
          automaticCompression: true,
        },
        (request, info) => {
          const context: ApiRequestContext = Object.freeze({
            remoteAddress: info.remoteAddr.hostname,
          });
          return handler(request, context);
        },
      );
      return Object.freeze({
        finished: server.finished,
        shutdown: () => server.shutdown(),
      });
    },
  });
}
