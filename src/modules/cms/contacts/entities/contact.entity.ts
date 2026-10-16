/** 员工联系方式（后台）——含内部备注 */
export interface ContactDto {
  id: string;
  adminUserId: string;
  displayName: string;
  jobTitle: string | null;
  displayEmail: string | null;
  whatsapp: string | null;
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

/** 公开联系方式（绝不包含 internalNote / loginEmail） */
export interface PublicContactDto {
  displayName: string;
  jobTitle: string | null;
  displayEmail: string | null;
  whatsapp: string | null;
  sortOrder: number;
}
