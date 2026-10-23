/**
 * Jest 全局 setup（在所有测试模块加载前执行）。
 *
 * 唯一职责：把存储适配器强制切回 LOCAL。
 *
 * 为什么：
 *   1. **e2e 绝不写真实云存储**——开发机 .env 里 STORAGE_PROVIDER=TENCENT_COS，
 *      e2e 跑上传会把测试图片写进生产 CDN 桶（media/YYYY/MM/<uuid>），
 *      污染生产资产且断言里的本地磁盘语义（/uploads 静态路由、落盘检查）
 *      全部失效。Phase 6.0 重构后 6 个 e2e suite 的失败即源于此。
 *   2. 单测（*.spec.ts）的存储替身不受影响——它们注入 mock provider。
 *
 * 注意：@nestjs/config 的 envFilePath 不会覆盖已存在的 process.env 键
 * （dotenv 语义），因此这里设置的值优先于 .env。
 * COS Provider 自身逻辑由 media-cms.spec 的 mock 覆盖 + 生产真实验证。
 */
process.env.STORAGE_PROVIDER = 'LOCAL';

/**
 * 上传大小上限同样钉死为代码默认值 10MB。
 *
 * media-file.util 的 MAX_MEDIA_FILE_SIZE 是 env 驱动（MEDIA_MAX_FILE_SIZE，
 * 生产 60MB / 开发机 .env 20MB）。e2e 的「超限返回 413」用例按 10MB 默认值
 * 编写；不钉死的话，在 .env 配了更大上限的机器上超限文件会穿过 multer、
 * 倒在魔数校验上（400 而非 413），测试结果随开发机配置漂移。
 */
process.env.MEDIA_MAX_FILE_SIZE = String(10 * 1024 * 1024);
process.env.UPLOAD_MAX_FILE_SIZE = String(10 * 1024 * 1024);
