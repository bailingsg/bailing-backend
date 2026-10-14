import { InternalServerErrorException, Injectable } from '@nestjs/common';
import { MediaProvider } from '@prisma/client';
import type { StoredObject, StorageProvider, UploadObject } from './storage.interface';

/**
 * 腾讯云 COS 存储提供方 —— **预留占位，本阶段不实现**。
 *
 * 存在目的：把「未来接入 COS」的接口契约与配置形状固定下来，
 * 避免接入时再来改动业务代码。实现落地时需要：
 *
 *   1. 安装 SDK：`npm i cos-nodejs-sdk-v5`
 *   2. 配置环境变量（建议命名，尚未写入 .env.example）：
 *        COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION
 *        COS_CDN_DOMAIN（对外访问域名，如 https://cdn.bailingwooden.com）
 *   3. 在 media.module.ts 的 provider 工厂中按 STORAGE_PROVIDER=TENCENT_COS 注册本类
 *   4. getUrl 返回 `${COS_CDN_DOMAIN}/${storageKey}`（CDN 域名，不带 bucket 域名）
 *   5. 历史 Local 资产需要执行一次搬迁脚本（按 storageKey 下载→上传→更新 url）
 *
 * 业务代码（MediaService / 各业务模块）不 import 本类，只依赖 StorageProvider 接口，
 * 因此上述替换对业务零侵入。
 */
@Injectable()
export class TencentCosStorageProvider implements StorageProvider {
  readonly provider = MediaProvider.TENCENT_COS;

  private notImplemented(): never {
    throw new InternalServerErrorException(
      '腾讯云 COS 存储提供方尚未实现（Phase 4.3 预留接口）。当前请使用 STORAGE_PROVIDER=LOCAL。',
    );
  }

  upload(_object: UploadObject): Promise<StoredObject> {
    return this.notImplemented();
  }

  delete(_storageKey: string): Promise<void> {
    return this.notImplemented();
  }

  getUrl(_storageKey: string): string {
    return this.notImplemented();
  }

  exists(_storageKey: string): Promise<boolean> {
    return this.notImplemented();
  }
}
