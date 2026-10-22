import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MediaModule } from '../../media/media.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

/**
 * 员工联系方式模块（Phase 4.6）。公开只读接口在 public 模块复用 ContactsService。
 *
 * 引入 MediaModule 是为了拿到 STORAGE_PROVIDER：员工头像采用
 * 「业务自己持有 storageKey、委托 StorageProvider 落地」的模式（而非 MediaAsset 外键），
 * 因为头像必须能被**替换时强制删除旧对象**——MediaAsset 会被引用检查拦住。
 * 依赖的仍是接口，切换 Local → COS 无需改动本模块。
 */
@Module({
  imports: [PrismaModule, MediaModule],
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
