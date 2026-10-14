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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { AddProductImageDto } from './dto/product-image.dto';
import { ProductsService } from './products.service';
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
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list(@Query() query: ListProductsQueryDto): Promise<PaginatedCmsProductsDto> {
    return this.productsService.list(query);
  }

  @Post()
  create(@Body() dto: CreateProductDto): Promise<CmsProductDetailDto> {
    return this.productsService.create(dto);
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<CmsProductDetailDto> {
    return this.productsService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto): Promise<CmsProductDetailDto> {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.productsService.remove(id);
  }

  /** 上传产品图片（multipart/form-data：file + alt + sortOrder + isPrimary） */
  @Post(':id/images')
  @UseInterceptors(FileInterceptor(IMAGE_FIELD, productImageUploadOptions()))
  addImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: AddProductImageDto,
  ): Promise<CmsProductImageDto> {
    if (!file) {
      throw new BadRequestException('请上传图片文件（字段名 file）');
    }
    return this.productsService.addImage(id, file, dto);
  }

  /** 删除产品图片 */
  @Delete(':id/images/:imageId')
  @HttpCode(HttpStatus.OK)
  removeImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ): Promise<{ id: string }> {
    return this.productsService.removeImage(id, imageId);
  }
}
