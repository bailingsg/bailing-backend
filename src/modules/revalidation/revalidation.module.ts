import { Global, Module } from '@nestjs/common';
import { RevalidationService } from './revalidation.service';

/**
 * 前台缓存失效模块（Phase 4.8）
 *
 * 声明为 @Global：所有 CMS 内容服务都需要注入 RevalidationService，
 * 无需在每个模块重复 import，避免遗漏导致「某类内容改了前台不刷新」。
 */
@Global()
@Module({
  providers: [RevalidationService],
  exports: [RevalidationService],
})
export class RevalidationModule {}
