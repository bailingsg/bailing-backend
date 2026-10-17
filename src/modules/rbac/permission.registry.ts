/**
 * 权限注册表（Phase 4.6，单一事实来源）。
 *
 * 设计原则：
 *   1. 权限是**后端安全边界**。前端只负责「是否展示入口」，
 *      真正的拦截发生在 PermissionsGuard（见 permissions.guard.ts）。
 *   2. 权限 key 全局唯一，格式 `<module>.<action>`，全部英文。
 *   3. `isNav` 区分「导航权限」与「功能权限」：
 *        · isNav=true  该权限同时决定侧边栏是否展示对应菜单入口
 *        · isNav=false 纯功能权限（如 disable / assign_permissions）
 *      注意：导航权限**不是**安全边界，隐藏菜单不等于拒绝请求。
 *   4. 权限清单由代码定义，seed 时同步入库（upsert，幂等）；
 *      运行时不动态新增权限，避免出现「UI 有开关但后端不认识」的幽灵权限。
 *   5. 绝不默认授予全部权限：新建角色权限集为空，由操作人显式勾选。
 *
 * 模块 action 约定（同一模块内保持一致）：
 *   read               查看列表/详情
 *   create             新建
 *   update             编辑（含保存编辑稿，**不含**发布）
 *   delete             删除
 *   disable            启用/停用
 *   manage             特殊管理（批量操作等）
 *   publish            发布（把编辑稿变成线上版本）
 *   unpublish          取消发布（下架，保留内容与历史）
 *   assign_permissions 分配权限（仅 roles 模块）
 *
 * Phase 1 起「编辑」与「发布」严格分离：`update` 只能改草稿，
 * 让内容对外可见必须持有 `publish`；`unpublish` 独立授予，
 * 避免「能改内容」隐含「能让内容下线」。
 */

/** 权限动作类型 */
export type PermissionAction =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'disable'
  | 'manage'
  | 'publish'
  | 'unpublish'
  | 'assign_permissions';

/** 单个权限定义 */
export interface PermissionDefinition {
  /** 全局唯一 key，如 `accounts.read` */
  key: string;
  /** 所属模块，如 `accounts`（英文，前端按此分组） */
  module: string;
  /** 动作 */
  action: PermissionAction;
  /** 中文名称（对操作人展示） */
  name: string;
  /** 中文说明（说明该权限的边界） */
  description: string;
  /** 是否同时作为导航权限（决定菜单入口可见性） */
  isNav: boolean;
  /** 展示排序（模块内） */
  sortOrder: number;
}

/** 模块定义（前端权限矩阵按此分组与排序） */
export interface PermissionModuleDefinition {
  /** 模块 key，与 PermissionDefinition.module 对应 */
  key: string;
  /** 中文模块名 */
  name: string;
  /** 模块排序 */
  sortOrder: number;
}

/**
 * 模块清单。顺序即前端权限矩阵的分组顺序。
 * 说明：`accounts` / `roles` / `contacts` / `lead_distribution` 为 Phase 4.6 新增；
 * 其余为既有已审计模块（挂权限校验时保持动作语义一致）。
 */
export const PERMISSION_MODULES: readonly PermissionModuleDefinition[] = [
  { key: 'accounts', name: '账号管理', sortOrder: 10 },
  { key: 'roles', name: '角色与权限', sortOrder: 20 },
  { key: 'contacts', name: '员工联系方式', sortOrder: 30 },
  { key: 'lead_distribution', name: '询盘分配', sortOrder: 40 },
  // Phase 0：询盘（RFQ）后台读取与状态跟进，从共享密钥通道并入 RBAC
  { key: 'rfq', name: '询盘管理', sortOrder: 45 },
  { key: 'dashboard', name: '工作台', sortOrder: 50 },
  { key: 'products', name: '产品管理', sortOrder: 60 },
  { key: 'categories', name: '产品分类', sortOrder: 70 },
  { key: 'media', name: '媒体库', sortOrder: 80 },
  { key: 'blog', name: '博客文章', sortOrder: 90 },
  { key: 'factory', name: '工厂实力', sortOrder: 100 },
  { key: 'quality', name: '质量体系', sortOrder: 110 },
  { key: 'applications', name: '应用场景', sortOrder: 120 },
  // Phase 4.7：站点结构化内容（首页 / 关于我们 / 联系页）与站内导航
  { key: 'site', name: '站点内容', sortOrder: 130 },
  { key: 'nav', name: '导航管理', sortOrder: 140 },
  // Phase 5.0：全站 SEO 基础设施（管理中心 / 审计 / 重定向 / 全局设置）
  { key: 'seo', name: 'SEO 管理', sortOrder: 150 },
] as const;

/**
 * 权限全集。
 *
 * 注意：这是**固定清单**，不随业务数据变化。
 * 新增权限必须改本文件并重新 seed，避免出现运行时幽灵权限。
 */
export const PERMISSIONS: readonly PermissionDefinition[] = [
  // ── 账号管理 ────────────────────────────────────────────────
  {
    key: 'accounts.read',
    module: 'accounts',
    action: 'read',
    name: '查看账号',
    description: '查看账号列表与详情（不含口令）',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'accounts.create',
    module: 'accounts',
    action: 'create',
    name: '新建账号',
    description: '创建员工账号并设置初始口令',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'accounts.update',
    module: 'accounts',
    action: 'update',
    name: '编辑账号',
    description: '修改账号姓名、邮箱、职位与所属角色',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'accounts.disable',
    module: 'accounts',
    action: 'disable',
    name: '启用/停用账号',
    description: '停用后该员工无法登录，且自动退出询盘分配队列',
    isNav: false,
    sortOrder: 40,
  },

  // ── 角色与权限 ──────────────────────────────────────────────
  {
    key: 'roles.read',
    module: 'roles',
    action: 'read',
    name: '查看角色',
    description: '查看角色列表、详情与权限矩阵',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'roles.create',
    module: 'roles',
    action: 'create',
    name: '新建角色',
    description: '创建自定义角色（初始不授予任何权限）',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'roles.update',
    module: 'roles',
    action: 'update',
    name: '编辑角色',
    description: '修改角色名称、描述与状态（受保护角色不可改）',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'roles.assign_permissions',
    module: 'roles',
    action: 'assign_permissions',
    name: '分配权限',
    description: '调整角色权限集；操作人不能授予超出自身范围的权限',
    isNav: false,
    sortOrder: 40,
  },

  // ── 员工联系方式 ────────────────────────────────────────────
  {
    key: 'contacts.read',
    module: 'contacts',
    action: 'read',
    name: '查看联系方式',
    description: '查看员工展示用联系方式（含内部备注）',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'contacts.update',
    module: 'contacts',
    action: 'update',
    name: '编辑联系方式',
    description: '修改展示名称、职位、展示邮箱、WhatsApp 与展示开关',
    isNav: false,
    sortOrder: 20,
  },

  // ── 询盘分配 ────────────────────────────────────────────────
  {
    key: 'lead_distribution.read',
    module: 'lead_distribution',
    action: 'read',
    name: '查看询盘分配',
    description: '查看当前轮询队列、倾斜计划进度与分配记录',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'lead_distribution.manage',
    module: 'lead_distribution',
    action: 'manage',
    name: '管理询盘分配计划',
    description: '创建倾斜计划、调整优先员工与目标数量',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'lead_distribution.close',
    module: 'lead_distribution',
    action: 'disable',
    name: '关闭倾斜计划',
    description: '手动关闭进行中的倾斜计划（查看进度不等于关闭）',
    isNav: false,
    sortOrder: 30,
  },

  // ── 询盘管理（Phase 0：RFQ 后台接口并入 RBAC）────────────────
  {
    key: 'rfq.read',
    module: 'rfq',
    action: 'read',
    name: '查看询盘',
    description: '查看客户询盘列表与详情（含联系方式与需求正文）',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'rfq.update',
    module: 'rfq',
    action: 'update',
    name: '跟进询盘状态',
    description: '更新询盘跟进状态（新询盘 / 已联系 / 已报价 / 已关闭）',
    isNav: false,
    sortOrder: 20,
  },

  // ── 工作台 ──────────────────────────────────────────────────
  {
    key: 'dashboard.read',
    module: 'dashboard',
    action: 'read',
    name: '查看工作台',
    description: '查看统计卡片与概览数据',
    isNav: true,
    sortOrder: 10,
  },

  // ── 产品管理 ────────────────────────────────────────────────
  {
    key: 'products.read',
    module: 'products',
    action: 'read',
    name: '查看产品',
    description: '查看产品列表与详情',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'products.create',
    module: 'products',
    action: 'create',
    name: '新建产品',
    description: '创建产品',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'products.update',
    module: 'products',
    action: 'update',
    name: '编辑产品',
    description: '修改产品信息',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'products.delete',
    module: 'products',
    action: 'delete',
    name: '删除产品',
    description: '删除产品（含图片文件清理）',
    isNav: false,
    sortOrder: 40,
  },

  {
    key: 'products.publish',
    module: 'products',
    action: 'publish',
    name: '发布产品',
    description: '把产品编辑稿发布为线上版本（对公开站可见）',
    isNav: false,
    sortOrder: 50,
  },
  {
    key: 'products.unpublish',
    module: 'products',
    action: 'unpublish',
    name: '取消发布产品',
    description: '将已发布产品下架（保留内容与发布历史，可重新发布）',
    isNav: false,
    sortOrder: 60,
  },

  // ── 产品分类 ────────────────────────────────────────────────
  {
    key: 'categories.read',
    module: 'categories',
    action: 'read',
    name: '查看分类',
    description: '查看产品分类',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'categories.create',
    module: 'categories',
    action: 'create',
    name: '新建分类',
    description: '创建产品分类',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'categories.update',
    module: 'categories',
    action: 'update',
    name: '编辑分类',
    description: '修改产品分类',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'categories.delete',
    module: 'categories',
    action: 'delete',
    name: '删除分类',
    description: '删除产品分类',
    isNav: false,
    sortOrder: 40,
  },

  // ── 媒体库 ──────────────────────────────────────────────────
  {
    key: 'media.read',
    module: 'media',
    action: 'read',
    name: '查看媒体库',
    description: '查看媒体资源列表与详情',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'media.upload',
    module: 'media',
    action: 'create',
    name: '上传媒体',
    description: '上传图片/文档到媒体库',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'media.update',
    module: 'media',
    action: 'update',
    name: '编辑媒体',
    description: '修改媒体元数据（标题、分类、替代文本）',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'media.delete',
    module: 'media',
    action: 'delete',
    name: '删除媒体',
    description: '删除媒体资源',
    isNav: false,
    sortOrder: 40,
  },

  // ── 博客文章 ────────────────────────────────────────────────
  {
    key: 'blog.read',
    module: 'blog',
    action: 'read',
    name: '查看文章',
    description: '查看文章与分类/标签',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'blog.create',
    module: 'blog',
    action: 'create',
    name: '新建文章',
    description: '撰写文章',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'blog.update',
    module: 'blog',
    action: 'update',
    name: '编辑文章',
    description: '修改文章内容与发布状态',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'blog.delete',
    module: 'blog',
    action: 'delete',
    name: '删除文章',
    description: '删除文章',
    isNav: false,
    sortOrder: 40,
  },

  {
    key: 'blog.publish',
    module: 'blog',
    action: 'publish',
    name: '发布文章',
    description: '把文章编辑稿发布为线上版本（对公开站可见）',
    isNav: false,
    sortOrder: 50,
  },
  {
    key: 'blog.unpublish',
    module: 'blog',
    action: 'unpublish',
    name: '取消发布文章',
    description: '将已发布文章下架（保留内容与发布历史，可重新发布）',
    isNav: false,
    sortOrder: 60,
  },

  // ── 工厂实力 ────────────────────────────────────────────────
  {
    key: 'factory.read',
    module: 'factory',
    action: 'read',
    name: '查看工厂实力',
    description: '查看工厂区块、图片与展会',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'factory.create',
    module: 'factory',
    action: 'create',
    name: '新建工厂内容',
    description: '新建区块/展会记录',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'factory.update',
    module: 'factory',
    action: 'update',
    name: '编辑工厂内容',
    description: '修改区块/展会内容与发布状态',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'factory.delete',
    module: 'factory',
    action: 'delete',
    name: '删除工厂内容',
    description: '删除区块/展会记录',
    isNav: false,
    sortOrder: 40,
  },

  {
    key: 'factory.publish',
    module: 'factory',
    action: 'publish',
    name: '发布工厂分区',
    description: '把工厂实力分区编辑稿发布为线上版本',
    isNav: false,
    sortOrder: 50,
  },
  {
    key: 'factory.unpublish',
    module: 'factory',
    action: 'unpublish',
    name: '取消发布工厂分区',
    description: '将已发布工厂实力分区下架（保留内容与历史）',
    isNav: false,
    sortOrder: 60,
  },

  // ── 质量体系 ────────────────────────────────────────────────
  {
    key: 'quality.read',
    module: 'quality',
    action: 'read',
    name: '查看质量体系',
    description: '查看质量记录',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'quality.create',
    module: 'quality',
    action: 'create',
    name: '新建质量记录',
    description: '新建质量记录',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'quality.update',
    module: 'quality',
    action: 'update',
    name: '编辑质量记录',
    description: '修改质量记录与发布状态',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'quality.delete',
    module: 'quality',
    action: 'delete',
    name: '删除质量记录',
    description: '删除质量记录',
    isNav: false,
    sortOrder: 40,
  },

  {
    key: 'quality.publish',
    module: 'quality',
    action: 'publish',
    name: '发布质量条目',
    description: '把质量体系条目编辑稿发布为线上版本',
    isNav: false,
    sortOrder: 50,
  },
  {
    key: 'quality.unpublish',
    module: 'quality',
    action: 'unpublish',
    name: '取消发布质量条目',
    description: '将已发布质量体系条目下架（保留内容与历史）',
    isNav: false,
    sortOrder: 60,
  },

  // ── 应用场景 ────────────────────────────────────────────────
  {
    key: 'applications.read',
    module: 'applications',
    action: 'read',
    name: '查看应用场景',
    description: '查看应用场景与关联产品',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'applications.create',
    module: 'applications',
    action: 'create',
    name: '新建应用场景',
    description: '新建应用场景',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'applications.update',
    module: 'applications',
    action: 'update',
    name: '编辑应用场景',
    description: '修改应用场景内容与发布状态',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'applications.delete',
    module: 'applications',
    action: 'delete',
    name: '删除应用场景',
    description: '删除应用场景',
    isNav: false,
    sortOrder: 40,
  },

  {
    key: 'applications.publish',
    module: 'applications',
    action: 'publish',
    name: '发布应用场景',
    description: '把应用场景编辑稿发布为线上版本',
    isNav: false,
    sortOrder: 50,
  },
  {
    key: 'applications.unpublish',
    module: 'applications',
    action: 'unpublish',
    name: '取消发布应用场景',
    description: '将已发布应用场景下架（保留内容与历史）',
    isNav: false,
    sortOrder: 60,
  },

  // ── 站点内容（Phase 4.7：首页 / 关于我们 / 联系页结构化分区） ──
  {
    key: 'site.read',
    module: 'site',
    action: 'read',
    name: '查看站点内容',
    description: '查看首页 / 关于我们 / 联系页的结构化内容分区',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'site.create',
    module: 'site',
    action: 'create',
    name: '新建站点分区',
    description: '新建站点内容分区（分区键页内唯一）',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'site.update',
    module: 'site',
    action: 'update',
    name: '编辑站点内容',
    description: '修改分区内容、排序与发布状态（草稿 / 已发布 / 已归档）',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'site.delete',
    module: 'site',
    action: 'delete',
    name: '删除站点分区',
    description: '删除站点内容分区',
    isNav: false,
    sortOrder: 40,
  },

  {
    key: 'site.publish',
    module: 'site',
    action: 'publish',
    name: '发布站点分区',
    description: '把首页 / 关于我们 / 联系页分区编辑稿发布为线上版本',
    isNav: false,
    sortOrder: 50,
  },
  {
    key: 'site.unpublish',
    module: 'site',
    action: 'unpublish',
    name: '取消发布站点分区',
    description: '将已发布站点分区下架（保留内容与历史）',
    isNav: false,
    sortOrder: 60,
  },

  // ── 导航管理（Phase 4.7：页眉 / 页脚链接） ──
  {
    key: 'nav.read',
    module: 'nav',
    action: 'read',
    name: '查看导航',
    description: '查看页眉 / 页脚导航项',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'nav.create',
    module: 'nav',
    action: 'create',
    name: '新建导航项',
    description: '新建页眉 / 页脚导航项（链接经安全校验）',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'nav.update',
    module: 'nav',
    action: 'update',
    name: '编辑导航项',
    description: '修改导航文案、链接、排序与启用状态',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'nav.delete',
    module: 'nav',
    action: 'delete',
    name: '删除导航项',
    description: '删除页眉 / 页脚导航项',
    isNav: false,
    sortOrder: 40,
  },
  // ── SEO 管理（Phase 5.0）────────────────────────────────────────
  {
    key: 'seo.read',
    module: 'seo',
    action: 'read',
    name: '查看 SEO 管理',
    description: '进入 SEO 管理中心，查看页面 / 产品 / 博客 SEO 状态与审计结果',
    isNav: true,
    sortOrder: 10,
  },
  {
    key: 'seo.manage',
    module: 'seo',
    action: 'manage',
    name: '管理页面 SEO',
    description: '编辑页面 / 产品 / 博客 / 分类的 SEO 元数据与结构化数据',
    isNav: false,
    sortOrder: 20,
  },
  {
    key: 'seo.audit',
    module: 'seo',
    action: 'manage',
    name: '运行 SEO 审计',
    description: '触发全站 SEO 审计（只读检查，不自动修改任何内容）',
    isNav: false,
    sortOrder: 30,
  },
  {
    key: 'seo.redirect',
    module: 'seo',
    action: 'manage',
    name: '管理重定向',
    description: '新建 / 编辑 / 停用 301 / 302 重定向规则',
    isNav: false,
    sortOrder: 40,
  },
  {
    key: 'seo.settings',
    module: 'seo',
    action: 'manage',
    name: '管理 SEO 全局设置',
    description: '维护站点信息、标题模板、公司资料、社交链接与站长工具配置',
    isNav: false,
    sortOrder: 50,
  },
] as const;

/** 全部权限 key（运行期常量，供校验/去重使用） */
export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

const PERMISSION_KEY_SET = new Set(ALL_PERMISSION_KEYS);

/** 判断是否为已注册的合法权限 key */
export function isValidPermissionKey(key: string): boolean {
  return PERMISSION_KEY_SET.has(key);
}

/** key → 定义 */
export const PERMISSION_BY_KEY: ReadonlyMap<string, PermissionDefinition> = new Map(
  PERMISSIONS.map((p) => [p.key, p]),
);

/**
 * 受保护的系统角色 key。
 *   · SUPER_ADMIN：超级管理员，拥有全部权限，且**不可停用、不可改权限、不可删除**
 *   · 仅允许修改其展示名称与描述
 * 任何角色管理操作都必须先校验目标角色是否受保护。
 */
export const PROTECTED_ROLE_KEYS = ['SUPER_ADMIN'] as const;

/** 超级管理员角色 key */
export const SUPER_ADMIN_ROLE_KEY = 'SUPER_ADMIN';

/** 判断角色是否受保护（禁止停用/改权限/删除） */
export function isProtectedRole(roleKey: string): boolean {
  return (PROTECTED_ROLE_KEYS as readonly string[]).includes(roleKey);
}

/**
 * 旧 AdminRole 枚举 → 新角色 key 的迁移映射。
 * 历史数据只有 ADMIN / EDITOR 两种，Phase 4.6 迁移规则：
 *   · ADMIN  → SUPER_ADMIN（唯一超级管理员角色）
 *   · EDITOR → CONTENT_EDITOR（内容编辑，仅内容类权限，**不升权**）
 * 明确禁止：把全部 EDITOR 提升为超级管理员。
 */
export const LEGACY_ROLE_MIGRATION: Readonly<Record<'ADMIN' | 'EDITOR', string>> = {
  ADMIN: SUPER_ADMIN_ROLE_KEY,
  EDITOR: 'CONTENT_EDITOR',
};
