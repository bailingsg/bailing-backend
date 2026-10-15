import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MediaService } from './media.service';
import { ListMediaQueryDto } from './dto/list-media-query.dto';
import { MAX_MEDIA_FILE_SIZE } from './media-file.util';
import type { MediaAssetDto, PaginatedMediaDto } from './entities/media.entity';

/** 上传表单的文件字段名（与 Admin 前端 FormData 约定一致） */
const FILE_FIELD = 'file';

/** 已鉴权请求（JwtAuthGuard 保证 user 存在） */
interface AuthedRequest {
  user: { id: string };
}

/**
 * 媒体资源 CMS API（Phase 4.3，控制器级 JwtAuthGuard，全部要求登录）。
 *
 *   POST   /api/v1/cms/media/upload   上传（multipart，字段 file；支持 JPEG/PNG/WebP/AVIF/PDF）
 *   GET    /api/v1/cms/media          列表（page/limit/keyword/category）
 *   GET    /api/v1/cms/media/:id      详情
 *   DELETE /api/v1/cms/media/:id      删除（引用检查：被业务引用 → 400）
 *
 * 文件以**内存存储**接收，落盘由 StorageProvider 统一完成——
 * 控制器与服务层都不直接接触文件系统路径。
 */
@Controller('cms/media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  /** 上传媒体（multipart/form-data：file） */
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor(FILE_FIELD, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_MEDIA_FILE_SIZE, files: 1 },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: AuthedRequest,
  ): Promise<MediaAssetDto> {
    if (!file) {
      throw new BadRequestException('请上传文件（字段名 file）');
    }
    return this.mediaService.upload(file, request.user.id);
  }

  /** 媒体列表（分页 + keyword / category 筛选） */
  @Get()
  list(@Query() query: ListMediaQueryDto): Promise<PaginatedMediaDto> {
    return this.mediaService.list(query);
  }

  /** 媒体详情 */
  @Get(':id')
  detail(@Param('id') id: string): Promise<MediaAssetDto> {
    return this.mediaService.findById(id);
  }

  /** 删除媒体（被 ProductImage 等引用时返回 400 Media asset is in use.） */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.mediaService.remove(id);
  }
}
