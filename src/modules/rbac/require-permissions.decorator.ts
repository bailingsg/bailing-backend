import { SetMetadata } from '@nestjs/common';

/** 权限元数据 key（PermissionsGuard 读取） */
export const PERMISSIONS_METADATA_KEY = 'requiredPermissions';

/** 权限校验模式 */
export type PermissionMode = 'all' | 'any';

export interface RequiredPermissionsMetadata {
  permissions: string[];
  mode: PermissionMode;
}

/**
 * 声明接口所需权限（Phase 4.6）。
 *
 * 用法：
 *   @RequirePermissions('accounts.read')
 *   @RequirePermissions('roles.update', 'roles.assign_permissions')          // 默认 AND
 *   @RequirePermissions({ any: ['lead_distribution.manage', 'lead_distribution.close'] })
 *
 * 语义：
 *   · 不传 / 传空 → 报错（避免写出「声明了装饰器但不校验」的假安全）
 *   · 默认 ALL：列出的权限必须**全部**具备
 *   · ANY：具备任意一个即可
 *
 * 重要：装饰器必须在 JwtAuthGuard 之后生效（Guard 执行顺序 = 声明顺序），
 * 因此受保护接口请写 @UseGuards(JwtAuthGuard, PermissionsGuard)。
 * 未登录时 JwtAuthGuard 先返回 401，权限不足时才由本守卫返回 403。
 */
export function RequirePermissions(...permissions: string[]): MethodDecorator & ClassDecorator {
  if (permissions.length === 0) {
    throw new Error(
      '@RequirePermissions 至少需要一个权限 key；如需「登录即可」请只使用 JwtAuthGuard。',
    );
  }
  return SetMetadata(PERMISSIONS_METADATA_KEY, {
    permissions,
    mode: 'all',
  } satisfies RequiredPermissionsMetadata);
}

/**
 * 任意一个权限满足即通过（OR 语义）。
 */
export function RequireAnyPermission(...permissions: string[]): MethodDecorator & ClassDecorator {
  if (permissions.length === 0) {
    throw new Error('@RequireAnyPermission 至少需要一个权限 key。');
  }
  return SetMetadata(PERMISSIONS_METADATA_KEY, {
    permissions,
    mode: 'any',
  } satisfies RequiredPermissionsMetadata);
}
