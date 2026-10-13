import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { ApiSuccessResponse } from '../types/api-response';

/**
 * 统一成功响应包装：所有成功响应统一为 { success: true, data } 结构。
 * 业务模块只需返回数据体，无需关心包装。
 */
@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiSuccessResponse<T>>
{
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T>> {
    return next.handle().pipe(map((data) => ({ success: true as const, data: data ?? null })));
  }
}
