import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { catchError, tap, throwError } from 'rxjs';
import { HookkitRegistry } from './registry.service.js';
import type { HookkitHttpRequest } from './types.js';

/**
 * Completes or releases the idempotency claim the guard took out, based on whether the
 * guarded route handler succeeded or threw. Paired with WebhookGuard via `@Webhook()` —
 * a guard alone can't know the handler's outcome, since guards run before it.
 */
export class WebhookLifecycleInterceptor implements NestInterceptor {
  private readonly registry: HookkitRegistry;

  constructor(registry: HookkitRegistry) {
    this.registry = registry;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<HookkitHttpRequest>();
    const pending = req.hookkitPending;
    if (!pending) return next.handle();

    return next.handle().pipe(
      tap(() => {
        void pending.complete();
      }),
      catchError((err) => {
        if (this.registry.onHandlerError === 'release') {
          void pending.release();
        }
        return throwError(() => err);
      }),
    );
  }
}

Injectable()(WebhookLifecycleInterceptor);
Inject(HookkitRegistry)(WebhookLifecycleInterceptor, undefined, 0);
