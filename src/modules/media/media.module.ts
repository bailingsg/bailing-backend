import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'node:path';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { STORAGE_PROVIDER, type StorageProvider } from './storage/storage.interface';
// 预留：cos-storage.provider.ts 已定义 TencentCosStorageProvider（未注册——
// 完成 COS 接入后按需在下方工厂中启用，业务代码零改动）

/** 本地媒体存储根目录（<cwd>/uploads/media，.gitignore 已排除 uploads/） */
export const MEDIA_UPLOAD_ROOT = path.resolve(
  process.env.MEDIA_UPLOAD_DIR ?? path.join(process.cwd(), 'uploads', 'media'),
);

/**
 * Media 模块（Phase 4.3）。
 *
 * Storage Provider 通过工厂按环境变量 STORAGE_PROVIDER 选择：
 *   · LOCAL（默认）：本地磁盘，开发期
 *   · TENCENT_COS：预留——配置即启动失败并给出明确指引（避免半成品状态被误用）
 *
 * 业务代码只依赖 StorageProvider 接口；未来实现 COS 后在此工厂注册即可，零业务侵入。
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
          throw new Error(
            'STORAGE_PROVIDER=TENCENT_COS 已配置，但腾讯云 COS 提供方尚未实现（Phase 4.3 预留接口）。请改用 LOCAL，或按 cos-storage.provider.ts 头部说明完成实现。',
          );
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
})
export class MediaModule {}
