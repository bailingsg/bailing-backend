import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RfqController } from './rfq.controller';
import { RfqService } from './rfq.service';
import { RfqAuthGuard } from './rfq-auth.guard';
import { LeadDistributionModule } from '../cms/lead-distribution/lead-distribution.module';
import { toExpiresIn } from '../auth/auth.types';

/**
 * RFQ 询盘模块。
 *
 * Phase 4.6：导入 LeadDistributionModule，使 RfqService 能在创建询盘的同一事务内
 * 自动分配承接人（倾斜计划 / 正常轮询）。分配失败不影响询盘入库。
 *
 * Phase 0：后台接口鉴权从「共享密钥（未配置即放行）」升级为
 * RfqAuthGuard（JWT + RBAC 主通道，X-Admin-Token 兼容通道 fail-closed）。
 * JwtModule 仅用于守卫验签，配置来源与 AuthModule 保持一致。
 */
@Module({
  imports: [
    LeadDistributionModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwtSecret'),
        signOptions: { expiresIn: toExpiresIn(config.getOrThrow<string>('jwtExpiresIn')) },
      }),
    }),
  ],
  controllers: [RfqController],
  providers: [RfqService, RfqAuthGuard],
  exports: [RfqService],
})
export class RfqModule {}
