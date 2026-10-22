import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthUser } from '../../auth/auth.types';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { AddProductImageDto } from './dto/product-image.dto';
import { ProductsService } from './products.service';
import { draftVersionFrom } from '../publishing/publishing.engine';
import { productImageUploadOptions } from './upload.options';
import type {
  CmsProductDetailDto,
  CmsProductImageDto,
  PaginatedCmsProductsDto,
} from './entities/product.entity';

/** 上传表单的文件字段名（与 Admin 前端 FormData 约定一致） */
const IMAGE_FIELD = 'file';

/**
 * 产品 CMS API（控制器级 JwtAuthGuard，全部要求登录）。
 *
 *   GET    /api/v1/cms/products                 列表（page/limit/keyword/status/categoryId）
 *   POST   /api/v1/cms/products                 创建
 *   GET    /api/v1/cms/products/:id             详情
 *   PATCH  /api/v1/cms/products/:id             更新
 *   DELETE /api/v1/cms/products/:id             删除（含图片文件清理）
 *   POST   /api/v1/cms/products/:id/images      上传图片（multipart）
 *   DELETE /api/v1/cms/products/:id/images/:imageId  删除图片
 */
@Controller('cms/products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @RequirePermissions('products.read')
  list(@Query() query: ListProductsQueryDto): Promise<PaginatedCmsProductsDto> {
    return this.productsService.list(query);
  }

  @Post()
  @RequirePermissions('products.create')
  create(@Body() dto: CreateProductDto): Promise<CmsProductDetailDto> {
    return this.productsService.create(dto);
  }

  @Get(':id')
  @RequirePermissions('products.read')
  detail(@Param('id') id: string): Promise<CmsProductDetailDto> {
    return this.productsService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('products.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() request: Request & { user?: AuthUser },
  ) {
    // Phase 1：已发布过的产品，普通保存只写编辑稿，绝不覆盖线上版本
    const state = await this.productsService.publishState(id);
    if (state.publishedVersion > 0 || state.hasDraft) {
      const draft = await this.productsService.saveDraft(
        id,
        dto,
        request.user?.id ?? null,
        draftVersionFrom(request.headers),
      );
      const current = await this.productsService.findById(id);
      return { ...current, hasUnpublishedChanges: true, draftVersion: draft.draftVersion };
    }
    return this.productsService.update(id, dto);
  }

  /** 发布当前编辑稿（独立权限 + 服务端校验） */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('products.publish')
  publish(@Param('id') id: string, @Req() request: Request & { user?: AuthUser }) {
    return this.productsService.publish(id, request.user?.id ?? null);
  }

  /** 取消发布（保留内容与历史） */
  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('products.unpublish')
  unpublish(@Param('id') id: string) {
    return this.productsService.unpublish(id);
  }

  /** 预览（线上版本 + 编辑稿，仅后台授权访问） */
  @Get(':id/preview')
  @RequirePermissions('products.read')
  preview(@Param('id') id: string) {
    return this.productsService.preview(id);
  }

  /** 发布历史 */
  @Get(':id/revisions')
  @RequirePermissions('products.read')
  revisions(@Param('id') id: string) {
    return this.productsService.revisions(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('products.delete')
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.productsService.remove(id);
  }

  /** 上传产品图片（multipart/form-data：file + alt + sortOrder + isPrimary） */
  @Post(':id/images')
  @UseInterceptors(FileInterceptor(IMAGE_FIELD, productImageUploadOptions()))
  @RequirePermissions('products.update')
  addImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: AddProductImageDto,
    @Req() request: Request & { user?: AuthUser },
  ): Promise<CmsProductImageDto> {
    if (!file) {
      throw new BadRequestException('请上传图片文件（字段名 file）');
    }
    return this.productsService.addImage(id, file, dto, request.user?.id);
  }

  /** 删除产品图片 */
  @Delete(':id/images/:imageId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('products.delete')
  removeImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ): Promise<{ id: string }> {
    return this.productsService.removeImage(id, imageId);
  }
}
