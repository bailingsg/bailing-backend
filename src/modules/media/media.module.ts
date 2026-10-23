import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'node:path';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { TencentCosStorageProvider } from './storage/cos-storage.provider';
import { STORAGE_PROVIDER, type StorageProvider } from './storage/storage.interface';

/** 本地媒体存储根目录（<cwd>/uploads/media，.gitignore 已排除 uploads/） */
export const MEDIA_UPLOAD_ROOT = path.resolve(
  process.env.MEDIA_UPLOAD_DIR ?? path.join(process.cwd(), 'uploads', 'media'),
);

/**
 * Media 模块（Phase 4.3）。
 *
 * Storage Provider 通过工厂按环境变量 STORAGE_PROVIDER 选择：
 *   · LOCAL（默认）：本地磁盘，开发期
 *   · TENCENT_COS：腾讯云对象存储，公网读取经 CDN（私有桶 + 回源鉴权）
 *
 * 配置缺失时启动即失败（见 env.validation.ts）——不允许静默退化为本地存储，
 * 否则会出现「上传成功但对象不在 COS」的假成功。
 *
 * 业务代码只依赖 StorageProvider 接口，切换存储零业务侵入。
 *
 * 导出说明：
 *   · MediaService —— 业务模块上传媒体的统一入口
 *   · STORAGE_PROVIDER —— 需要「直传对象 + 自己管 key」的业务（如员工头像）
 *     直接注入该 token，仍只依赖接口，不绑定具体实现
 */
@Module({
  controllers: [MediaController],
  providers: [
    MediaService,
    {
      provide: STORAGE_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageProvider => {
        const provider = (config.get<string>('storageProvider') ?? 'LOCAL').toUpperCase();

        if (provider === 'TENCENT_COS') {
          const cos = config.get<{
            secretId: string;
            secretKey: string;
            bucket: string;
            region: string;
            cdnDomain: string;
          }>('cos');
          if (!cos?.secretId || !cos?.secretKey || !cos?.bucket || !cos?.region || !cos?.cdnDomain) {
            // 兜底：正常情况已被 env.validation 拦下，此处防御直接注入配置的场景
            throw new Error(
              'STORAGE_PROVIDER=TENCENT_COS 但 COS 配置不完整：需要 TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY / TENCENT_COS_BUCKET / TENCENT_COS_REGION / COS_CDN_DOMAIN',
            );
          }
          return new TencentCosStorageProvider({
            secretId: cos.secretId,
            secretKey: cos.secretKey,
            bucket: cos.bucket,
            region: cos.region,
            cdnDomain: cos.cdnDomain,
          });
        }

        return new LocalStorageProvider({
          rootDir: MEDIA_UPLOAD_ROOT,
          uploadsBaseUrl:
            config.get<string>('uploadsBaseUrl') ??
            `http://127.0.0.1:${process.env.PORT ?? '4000'}`,
        });
      },
    },
  ],
  exports: [MediaService, STORAGE_PROVIDER],
})
export class MediaModule {}
