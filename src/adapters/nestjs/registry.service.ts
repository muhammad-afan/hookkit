import { Inject, Injectable } from '@nestjs/common';
import type { HooksentinelError } from '../../core/errors.js';
import type {
  PipelineIdempotencyConfig,
  PipelineOutcome,
  RunPipelineParams,
} from '../../core/pipeline.js';
import { defaultJsonParse, runPipeline } from '../../core/pipeline.js';
import { DEFAULT_MAX_BODY_BYTES, toWebhookRequest } from '../../core/request.js';
import type { WebhookRequest } from '../../core/types.js';
import { HOOKSENTINEL_MODULE_OPTIONS } from './tokens.js';
import type { HooksentinelModuleOptions, HooksentinelProviderConfig } from './types.js';

// No `@Injectable()` / `@Inject()` decorator syntax here — this file is bundled
// through hooksentinel's own build, which would need a decorator-helpers runtime package
// (@oxc-project/runtime) to emit legacy decorators, breaking hooksentinel's zero-dependency
// guarantee. Applying the decorator factories as plain function calls produces the
// identical Reflect metadata NestJS's DI reads — this is the same pattern NestJS's own
// `mixin()` helper uses internally (see @nestjs/common's injectable.decorator.js).
export class HooksentinelRegistry {
  private readonly options: HooksentinelModuleOptions;

  constructor(options: HooksentinelModuleOptions) {
    this.options = options;
  }

  private getProvider(name: string): HooksentinelProviderConfig {
    const provider = this.options.providers[name];
    if (!provider) {
      throw new Error(
        `hooksentinel: no provider registered for "${name}". Did you add it to HooksentinelModule.forRootAsync({ providers: { ${name}: ... } })?`,
      );
    }
    return provider;
  }

  buildWebhookRequest(
    name: string,
    raw: {
      body: Buffer;
      headers: Record<string, string | string[] | undefined>;
      url?: string | undefined;
      method?: string | undefined;
    },
  ): WebhookRequest {
    void this.getProvider(name); // validate the provider is registered before doing any work
    return toWebhookRequest({
      body: raw.body,
      headers: raw.headers,
      url: raw.url,
      method: raw.method,
      maxBodyBytes: this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    });
  }

  async run(name: string, req: WebhookRequest): Promise<PipelineOutcome<unknown>> {
    const provider = this.getProvider(name);
    const idempotency: PipelineIdempotencyConfig | undefined = this.options.store
      ? {
          store: this.options.store,
          ttlSeconds: this.options.ttlSeconds,
          onStoreError: this.options.onStoreError,
        }
      : undefined;

    const params: RunPipelineParams<unknown> = {
      adapter: provider.adapter,
      credentials: provider.credentials,
      verifyOptions: provider.verify,
      idempotency,
      maxBodyBytes: this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      parse: provider.parse ?? defaultJsonParse,
      req,
    };

    return runPipeline(params);
  }

  get onHandlerError(): 'release' | 'keep' {
    return this.options.onHandlerError ?? 'release';
  }

  async reportError(error: HooksentinelError, req: WebhookRequest): Promise<void> {
    await this.options.onError?.(error, req);
  }
}

Injectable()(HooksentinelRegistry);
Inject(HOOKSENTINEL_MODULE_OPTIONS)(HooksentinelRegistry, undefined, 0);
