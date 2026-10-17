import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 订单附件文件存储（Phase 5.2）。
 *
 * 与媒体库隔离的关键设计：
 *   · 独立命名空间 orders/<YYYY>/<MM>/<uuid>.<ext>，物理目录 <cwd>/uploads/orders
 *   · **不挂载静态路由**——媒体库静态目录（/uploads/media）之外，任何订单文件
 *     只能经 GET /cms/orders/:id/attachments/:attachmentId/file 鉴权后流式输出，
 *     杜绝「知道 URL 就能直接下载」的越权访问
 *   · storageKey 白名单校验（防路径穿越），与 LocalStorageProvider 同等强度
 *
 * 说明：StorageProvider 接口面向媒体库（仅 upload/delete/url/exists），
 * 订单附件需要鉴权读取，故在本模块内实现最小文件访问；未来接 COS 时
 * 以同样的接口边界替换本服务实现即可。
 */

/** 订单附件仅允许图片 MIME */
export const ORDER_ATTACHMENT_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const MAX_ORDER_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB / 张
export const MAX_ORDER_ATTACHMENTS = 10; // 单订单照片上限

const STORAGE_KEY_PATTERN =
  /^orders\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;

@Injectable()
export class OrderFileService {
  private readonly logger = new Logger(OrderFileService.name);

  private readonly rootDir = path.join(process.cwd(), 'uploads', 'orders');

  /** 校验并保存文件，返回 storageKey */
  async save(buffer: Buffer, mimeType: string): Promise<string> {
    const ext = ORDER_ATTACHMENT_MIME[mimeType];
    if (!ext) {
      throw new BadRequestException(`不支持的订单图片格式: ${mimeType}（仅允许 jpeg / png / webp）`);
    }
    if (buffer.length === 0 || buffer.length > MAX_ORDER_ATTACHMENT_SIZE) {
      throw new BadRequestException('订单图片大小超出限制（1B ~ 10MB）');
    }
    const now = new Date();
    const key = `orders/${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}/${String(
      now.getDate(),
    ).padStart(2, '0')}/${randomUUID()}.${ext}`;
    const resolved = this.resolve(key);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, buffer);
    return key;
  }

  /** 读取文件内容（鉴权后由控制器流式输出） */
  async read(storageKey: string): Promise<Buffer> {
    const resolved = this.resolve(storageKey);
    return readFile(resolved);
  }

  /** 删除文件（不存在时静默成功——调用方负责数据库先行） */
  async remove(storageKey: string): Promise<void> {
    try {
      await unlink(this.resolve(storageKey));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      this.logger.error(
        `订单附件文件删除失败: ${storageKey}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** storageKey 白名单 + 解析路径包含校验（防穿越总闸） */
  private resolve(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new BadRequestException('非法的附件存储键');
    }
    const resolved = path.resolve(this.rootDir, storageKey.replace(/^orders[/\\]/, ''));
    const rootResolved = path.resolve(this.rootDir);
    if (!resolved.startsWith(rootResolved + path.sep)) {
      throw new BadRequestException('非法的附件存储键');
    }
    return resolved;
  }
}
