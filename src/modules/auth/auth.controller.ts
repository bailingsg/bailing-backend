import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { UpdateMyProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AdminProfileDto, LoginResponseDto, MyProfileDto } from './auth.dto';
import type { AuthUser } from './auth.types';
import { MAX_MEDIA_FILE_SIZE } from '../media/media-file.util';

/**
 * 管理员认证 API（Phase 4.1）。
 *
 *   POST   /api/v1/auth/login            邮箱 + 口令 → JWT accessToken（公开）
 *   GET    /api/v1/auth/me               当前登录管理员（JWT 保护）
 *   GET    /api/v1/auth/profile          我的资料：账号档案 + 自己的联系方式（JWT 保护）
 *   PATCH  /api/v1/auth/profile          自助修改我的资料（JWT 保护，无需额外权限）
 *   PUT    /api/v1/auth/profile/avatar   自助上传 / 替换头像（multipart，字段 file）
 *   DELETE /api/v1/auth/profile/avatar   自助移除头像（同时删除存储对象）
 *   POST   /api/v1/auth/change-password  自助修改登录口令（校验当前口令）
 *
 * 阶段约定：只实现 access token（默认 12h），不引入 refresh token。
 * 前端通过 HttpOnly Cookie 持有令牌（见 bailing-admin 登录路由）。
 *
 * /auth/profile 与 /auth/change-password 刻意**不挂 PermissionsGuard**：
 * 维护自己的资料/口令属于自助行为，不应要求 contacts.update
 * （业务员只有 contacts.read）。身份边界由 JWT 里的 sub 保证——只能改自己。
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 登录：成功返回 accessToken 与用户摘要；失败统一 401 */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }

  /** 当前用户：解析 Authorization: Bearer <token> */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() request: Request & { user: AuthUser }): Promise<AdminProfileDto> {
    return this.authService.me(request.user);
  }

  /** 我的资料（账号设置页回填用） */
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  myProfile(@Req() request: Request & { user: AuthUser }): Promise<MyProfileDto> {
    return this.authService.myProfile(request.user);
  }

  /** 自助修改我的资料（姓名 / 登录邮箱 / 职位 / 官网展示联系方式） */
  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  updateMyProfile(
    @Body() dto: UpdateMyProfileDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<MyProfileDto> {
    return this.authService.updateMyProfile(request.user, dto);
  }

  /**
   * 自助上传 / 替换头像（multipart/form-data，字段名 file）。
   *
   * 内存接收 → StorageProvider 落地（Local / COS 透明）；
   * 替换时先传新对象、落库后再**删除旧对象**，服务器上不留孤儿文件。
   * MIME / 大小 / 魔数校验在 Service 层完成。
   */
  @Put('profile/avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_MEDIA_FILE_SIZE, files: 1 },
    }),
  )
  uploadMyAvatar(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: Request & { user: AuthUser },
  ): Promise<MyProfileDto> {
    if (!file) throw new BadRequestException('请上传头像文件（字段名 file）');
    return this.authService.setMyAvatar(request.user, file);
  }

  /** 自助移除头像（同时删除存储对象） */
  @Delete('profile/avatar')
  @UseGuards(JwtAuthGuard)
  removeMyAvatar(@Req() request: Request & { user: AuthUser }): Promise<MyProfileDto> {
    return this.authService.removeMyAvatar(request.user);
  }

  /** 自助修改登录口令：必须提供当前口令 */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  changePassword(
    @Body() dto: ChangePasswordDto,
    @Req() request: Request & { user: AuthUser },
  ): Promise<{ changed: true }> {
    return this.authService.changePassword(request.user, dto);
  }
}
