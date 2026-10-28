/**
 * ISO 3166-1 alpha-2 → 中文国家名。
 *
 * 用 `Intl.DisplayNames`（Node 自带 full-icu）而不是手写 250 国映射表：
 * 映射表必然会漏、会过期，且每次新增国家都要改代码。构造失败（极简 ICU
 * 构建）时退回原始代码，页面显示 `US` 而不是空白——宁可难看，不可空白。
 *
 * 只在服务端调用：后台是中文界面，前端不再做一次映射，避免两边口径漂移。
 */
const displayNames = (() => {
  try {
    return new Intl.DisplayNames(['zh-CN'], { type: 'region' });
  } catch {
    return null;
  }
})();

/** 国家代码 → 中文名；未知代码或 null 返回 null（前端显示「未知」） */
export function countryDisplayName(code: string | null | undefined): string | null {
  if (!code) return null;
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  try {
    // Intl 对未收录代码返回原代码（如 "ZZ" → "未知地区"），两者都可接受
    return displayNames?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}
