import { IsEnum } from 'class-validator';
import { RfqStatus } from '@prisma/client';

/**
 * PATCH /api/v1/rfq/:id/status 请求体。
 *
 * 只允许在 NEW / CONTACTED / QUOTED / CLOSED 之间流转。
 */
export class UpdateRfqStatusDto {
  @IsEnum(RfqStatus, {
    message: `status 必须是 ${Object.values(RfqStatus).join(' / ')} 之一`,
  })
  status!: RfqStatus;
}
