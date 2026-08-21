import type { DynamicModule, FactoryProvider, ModuleMetadata } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { HooksentinelRegistry } from './registry.service.js';
import { HOOKSENTINEL_MODULE_OPTIONS } from './tokens.js';
import type { HooksentinelModuleOptions } from './types.js';

export interface HooksentinelModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly inject?: FactoryProvider['inject'];
  readonly useFactory: (
    ...args: never[]
  ) => HooksentinelModuleOptions | Promise<HooksentinelModuleOptions>;
}

/**
 * Registers hooksentinel's providers, idempotency store, and the `WebhookGuard`/
 * `WebhookLifecycleInterceptor` dependency graph. Global — import it once in
 * `AppModule`; `@Webhook()` works in any feature module without re-importing it.
 *
 * @example
 * @Module({
 *   imports: [
 *     HooksentinelModule.forRootAsync({
 *       inject: [ConfigService, REDIS],
 *       useFactory: (config: ConfigService, redis: Redis) => ({
 *         store: redisStore({ client: redis }),
 *         providers: {
 *           stripe: {
 *             adapter: stripe,
 *             credentials: { type: 'secret', secret: config.getOrThrow('STRIPE_WEBHOOK_SECRET') },
 *           },
 *         },
 *       }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 */
export class HooksentinelModule {
  static forRootAsync(options: HooksentinelModuleAsyncOptions): DynamicModule {
    return {
      module: HooksentinelModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: HOOKSENTINEL_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        HooksentinelRegistry,
      ],
      exports: [HooksentinelRegistry],
    };
  }
}

Module({})(HooksentinelModule);
