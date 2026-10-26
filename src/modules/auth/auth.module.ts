import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaModule } from '../media/media.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { toExpiresIn } from './auth.types';

/**
 * 认证模块（Phase 4.1）。
 *
 * JWT 配置全部来自环境变量（JWT_SECRET / JWT_EXPIRES_IN），
 * 代码不提供任何默认密钥；缺失/过短时的处理见 config/env.validation.ts。
 *
 * MediaModule：自助头像上传需要注入 STORAGE_PROVIDER（Local / COS 透明），
 * 只依赖 StorageProvider 接口，不绑定具体存储实现。
 */
@Module({
  imports: [
    PrismaModule,
    PassportModule,
    MediaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwtSecret'),
        signOptions: { expiresIn: toExpiresIn(config.getOrThrow<string>('jwtExpiresIn')) },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
