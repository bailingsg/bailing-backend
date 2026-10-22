import { SetMetadata } from '@nestjs/common';

/** 「跳过统一响应包装」元数据 key（TransformInterceptor 读取） */
export const SKIP_TRANSFORM_METADATA_KEY = 'skipTransform';

/**
 * 声明该路由的成功响应**不**经 TransformInterceptor 包装，控制器返回什么，
 * 响应体就是什么。
 *
 * 使用场景（极少）：响应体结构本身就是契约的端点。当前唯一使用者是
 * `POST /api/v1/visitor/track`——访客统计实现规格 4.1 要求其恒返回
 * `200 {"success": true}` 且响应体只有这一个键，使上报端点不成为可探测的
 * 「统计查询接口」（返回值一旦带计数/ID/时间戳，脚本即可反推阈值）。
 *
 * 默认仍由 TransformInterceptor 包装为 `{ success: true, data }`；
 * 新增跳过点必须在此注释中登记理由。
 */
export const SkipTransform = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_TRANSFORM_METADATA_KEY, true);
