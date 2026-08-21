import type { DynamicModule, FactoryProvider, ModuleMetadata } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { HookkitRegistry } from './registry.service.js';
import { HOOKKIT_MODULE_OPTIONS } from './tokens.js';
import type { HookkitModuleOptions } from './types.js';

export interface HookkitModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly inject?: FactoryProvider['inject'];
  readonly useFactory: (...args: never[]) => HookkitModuleOptions | Promise<HookkitModuleOptions>;
}

/**
 * Registers hookforge's providers, idempotency store, and the `WebhookGuard`/
 * `WebhookLifecycleInterceptor` dependency graph. Global — import it once in
 * `AppModule`; `@Webhook()` works in any feature module without re-importing it.
 *
 * @example
 * @Module({
 *   imports: [
 *     HookkitModule.forRootAsync({
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
export class HookkitModule {
  static forRootAsync(options: HookkitModuleAsyncOptions): DynamicModule {
    return {
      module: HookkitModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: HOOKKIT_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        HookkitRegistry,
      ],
      exports: [HookkitRegistry],
    };
  }
}

Module({})(HookkitModule);
