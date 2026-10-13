import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiErrorResponse } from '../types/api-response';

/**
 * 统一异常处理过滤器。
 * - HttpException：保留原状态码，提取面向客户端的 message；
 * - 未预期异常：统一 500，真实堆栈只进服务端日志，绝不回显给客户端。
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const body = payload as { message?: string | string[]; error?: string };
        message = body.message ?? body.error ?? exception.message;
        // class-validator 校验失败时 message 为字符串数组，放入 details 便于前端展示
        details = Array.isArray(message) ? { validationErrors: message } : undefined;
      } else {
        message = exception.message;
      }
    } else {
      // 未预期异常：详细堆栈只记录到服务端日志
      const err = exception as Error;
      this.logger.error(`Unhandled exception: ${err?.message}`, err?.stack);
    }

    const body: ApiErrorResponse = {
      success: false,
      error: { code: status, message, ...(details ? { details } : {}) },
    };

    response.status(status).json(body);
  }
}
