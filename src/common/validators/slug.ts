/**
 * slug 通用校验常量（产品 / 博客分类 / 博客标签 / 博客文章共用）。
 *
 * 约定：小写字母、数字与连字符，不允许连续连字符与首尾连字符。
 * 例：wood-products、plywood-2026、about-us
 */
export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SLUG_REGEX = new RegExp(SLUG_PATTERN);
export const SLUG_MESSAGE = 'slug 只能包含小写字母、数字与连字符（如 wood-products）';
