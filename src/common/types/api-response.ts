/** 统一 API 响应结构定义（成功响应由 TransformInterceptor 包装） */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T | null;
}

/** 统一错误响应结构（由 HttpExceptionFilter 包装） */
export interface ApiErrorResponse {
  success: false;
  error: {
    /** HTTP 状态码，或业务错误码 */
    code: number | string;
    /** 面向客户端的错误描述，禁止包含敏感信息 */
    message: string | string[];
    /** 可选的附加信息，如参数校验明细 */
    details?: unknown;
  };
}
