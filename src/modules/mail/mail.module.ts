import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * 邮件模块（询盘通知）。
 *
 * 设为 @Global：询盘、未来可能的其他通知（状态流转 / 内容提醒）无需各自重复 import。
 * SMTP 未配置时 MailService 自动降级为「只记日志不发信」，不影响任何业务接口。
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
