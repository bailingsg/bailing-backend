import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { MulterError } from 'multer';
import { ApiErrorResponse } from '../types/api-response';

/**
 * multer 上传错误码 → 面向客户端的可读信息（Phase 4.3）。
 * MulterError 不属于 HttpException（平台层已先行转换为 413/400）；
 * 此处为兜底：直连 multer 或其他路径的 MulterError 统一降为 400。
 * 上传类失败本质是客户端请求问题，统一降为 400。
 */
const MULTER_ERROR_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: '文件超过大小限制',
  LIMIT_FILE_COUNT: '只能上传一个文件',
  LIMIT_UNEXPECTED_FILE: '文件字段不匹配（应为 file）',
  LIMIT_PART_COUNT: '表单字段过多',
  LIMIT_FIELD_KEY: '表单字段名过长',
  LIMIT_FIELD_VALUE: '表单字段值过长',
  LIMIT_FIELD_COUNT: '表单字段数量过多',
};

function multerErrorMessage(code: string): string {
  return MULTER_ERROR_MESSAGES[code] ?? '上传失败，请检查文件后重试';
}

/**
 * 统一异常处理过滤器。
 * - MulterError：上传类错误降级为 400，返回可读信息；
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

    if (exception instanceof MulterError) {
      status = HttpStatus.BAD_REQUEST;
      message = multerErrorMessage(exception.code);
    } else if (exception instanceof HttpException) {
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
