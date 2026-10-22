import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { ApiSuccessResponse } from '../types/api-response';
import { SKIP_TRANSFORM_METADATA_KEY } from '../decorators/skip-transform.decorator';

/**
 * 统一成功响应包装：所有成功响应统一为 { success: true, data } 结构。
 * 业务模块只需返回数据体，无需关心包装。
 *
 * 例外：被 @SkipTransform() 标注的路由（当前仅 POST /api/v1/visitor/track，
 * 见 skip-transform.decorator.ts 的登记说明）原样返回，不套 data。
 */
@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiSuccessResponse<T> | T>
{
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T> | T> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TRANSFORM_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return next.handle();
    }
    return next.handle().pipe(map((data) => ({ success: true as const, data: data ?? null })));
  }
}
