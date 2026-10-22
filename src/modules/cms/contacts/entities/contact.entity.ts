/** 员工联系方式（后台）——含内部备注 */
export interface ContactDto {
  id: string;
  adminUserId: string;
  displayName: string;
  jobTitle: string | null;
  displayEmail: string | null;
  whatsapp: string | null;
  /** 对外展示手机号（可直接拨打；与 whatsapp 相互独立） */
  phone: string | null;
  /** 头像访问地址（provider 生成；COS 场景为 CDN 域名）。无头像时 null，前台回退首字母 */
  avatarUrl: string | null;
  /** 头像存储对象键（仅后台可见，用于核对存储中的实际对象；公开接口绝不返回） */
  avatarKey: string | null;
  showOnSite: boolean;
  isLeadContact: boolean;
  sortOrder: number;
  /** 内部备注（仅后台可见，公开接口绝不返回） */
  internalNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** 关联的员工账号摘要（防幽灵员工的依据） */
  employee: {
    id: string;
    name: string | null;
    email: string;
    /** 账号登录邮箱（与展示邮箱区分） */
    loginEmail: string;
    isActive: boolean;
  };
}

/** 员工联系方式列表（含「未绑定联系方式的员工」占位项） */
export interface ContactListDto {
  items: ContactDto[];
  total: number;
  /** 尚未绑定联系方式的员工账号（前端提示补全） */
  employeesWithoutContact: { id: string; name: string | null; email: string; jobTitle: string | null }[];
}

/** 公开联系方式（绝不包含 internalNote / loginEmail / avatarKey） */
export interface PublicContactDto {
  displayName: string;
  jobTitle: string | null;
  displayEmail: string | null;
  whatsapp: string | null;
  phone: string | null;
  avatarUrl: string | null;
  sortOrder: number;
}
