import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PostStatus } from '@prisma/client';
import { sanitizeRichText } from '../src/modules/cms/blog/rich-text.sanitizer';
import { BlogPostsService } from '../src/modules/cms/blog/blog-posts.service';
import { BlogCategoriesService } from '../src/modules/cms/blog/blog-categories.service';
import { BlogTagsService } from '../src/modules/cms/blog/blog-tags.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { makeRevalidationMock } from './helpers/revalidation-mock';
import type { CreateBlogPostDto, UpdateBlogPostDto } from '../src/modules/cms/blog/dto/blog-post.dto';
import type { ListBlogPostsQueryDto } from '../src/modules/cms/blog/dto/list-blog-posts-query.dto';

/**
 * Blog CMS 单元测试（Phase 4.4）。
 *
 * 覆盖任务书要求：
 *   · XSS 富文本过滤（script/事件处理器/javascript:/data: 协议 / 实体编码绕过 / 畸形标签）
 *   · Blog CRUD（分页筛选、创建默认值、更新三态语义、404/409）
 *   · SEO 字段保存（seoTitle / seoDescription / seoKeywords / canonicalUrl / OG / Twitter）
 *   · 分类 CRUD（排序、禁用、有文章时禁删）
 *   · 标签 CRUD（引用计数、级联解绑）
 *   · Media 关联（封面存在性校验 + coverImageUrl 快照同步）
 *
 * 数据库不参与：PrismaClient 以 jest mock 替换。
 */

const NOW = new Date('2026-10-14T12:00:00.000Z');

/* ============================ 1. XSS 过滤 ============================ */

describe('sanitizeRichText（XSS 白名单过滤）', () => {
  it('整体丢弃 <script> 及其内容', () => {
    expect(sanitizeRichText('<script>alert(1)</script>')).toBe('');
    expect(sanitizeRichText('<p>ok</p><script>alert(1)</script>')).toBe('<p>ok</p>');
  });

  it('整体丢弃 style / iframe / svg / object / embed / form', () => {
    expect(sanitizeRichText('<style>body{display:none}</style>')).toBe('');
    expect(sanitizeRichText('<iframe src="https://evil.test"></iframe>')).toBe('');
    expect(sanitizeRichText('<svg onload="alert(1)"></svg>')).toBe('');
    expect(sanitizeRichText('<object data="x"></object>')).toBe('');
    expect(sanitizeRichText('<embed src="x">')).toBe('');
    expect(sanitizeRichText('<form action="/steal"><input name="p"></form>')).toBe('');
  });

  it('剔除事件处理器属性（onerror / onclick / onload）', () => {
    expect(sanitizeRichText('<img src="x" onerror="alert(1)">')).toBe('<img src="x">');
    expect(sanitizeRichText('<p onclick="alert(1)">hi</p>')).toBe('<p>hi</p>');
    expect(sanitizeRichText('<a href="/ok" onmouseover="alert(1)">x</a>')).toBe('<a href="/ok">x</a>');
  });

  it('剔除 style / class / id / data-* 等非白名单属性', () => {
    expect(sanitizeRichText('<div style="color:red" class="c" id="i">x</div>')).toBe('<div>x</div>');
    expect(sanitizeRichText('<span data-x="1">y</span>')).toBe('<span>y</span>');
  });

  it('拒绝 javascript: 协议（含大小写混淆）', () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichText('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichText('<a href="  javascript:alert(1)  ">x</a>')).toBe('<a>x</a>');
  });

  it('拒绝实体/控制字符编码绕过的协议（&#106;avascript: / java&#09;script:）', () => {
    expect(sanitizeRichText('<a href="&#106;avascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichText('<a href="&#x6a;avascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichText('<a href="java&#09;script:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichText('<a href="jav&#x0A;ascript:alert(1)">x</a>')).toBe('<a>x</a>');
  });

  it('拒绝 data: / vbscript: / file: 协议', () => {
    expect(sanitizeRichText('<img src="data:image/png;base64,AAAA">')).toBe('<img>');
    expect(sanitizeRichText('<a href="vbscript:msgbox(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichText('<a href="file:///etc/passwd">x</a>')).toBe('<a>x</a>');
  });

  it('保留 http / https / mailto 与相对地址', () => {
    expect(sanitizeRichText('<a href="https://example.com/a?b=1">x</a>')).toBe(
      '<a href="https://example.com/a?b=1">x</a>',
    );
    expect(sanitizeRichText('<a href="mailto:hi@bailingwooden.com">mail</a>')).toBe(
      '<a href="mailto:hi@bailingwooden.com">mail</a>',
    );
    expect(sanitizeRichText('<a href="/blog/post-1">x</a>')).toBe('<a href="/blog/post-1">x</a>');
    expect(sanitizeRichText('<a href="#anchor">x</a>')).toBe('<a href="#anchor">x</a>');
  });

  it('target="_blank" 时强制补 rel="noopener noreferrer"（并忽略作者传入的 rel）', () => {
    expect(sanitizeRichText('<a href="https://x.com" target="_blank">x</a>')).toBe(
      '<a href="https://x.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
    expect(sanitizeRichText('<a href="https://x.com" target="_blank" rel="opener">x</a>')).toBe(
      '<a href="https://x.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
    // 非 _blank 的 target 一律丢弃
    expect(sanitizeRichText('<a href="https://x.com" target="_self">x</a>')).toBe(
      '<a href="https://x.com">x</a>',
    );
  });

  it('保留 Media Library 图片（含 alt / 尺寸）', () => {
    const html = '<img src="http://127.0.0.1:4000/uploads/media/2026/10/a.png" alt="板材" width="640" height="480">';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it('保留基础排版标签与嵌套结构', () => {
    const html = '<h2>标题</h2><p>Hello <strong>World</strong> &amp; <em>more</em></p><ul><li>a</li></ul>';
    expect(sanitizeRichText(html)).toBe(html);
    expect(sanitizeRichText('<blockquote><p>quote</p></blockquote><pre><code>x = 1</code></pre>')).toBe(
      '<blockquote><p>quote</p></blockquote><pre><code>x = 1</code></pre>',
    );
    expect(sanitizeRichText('<table><thead><tr><th scope="col">H</th></tr></thead><tbody><tr><td colspan="2">v</td></tr></tbody></table>')).toBe(
      '<table><thead><tr><th scope="col">H</th></tr></thead><tbody><tr><td colspan="2">v</td></tr></tbody></table>',
    );
  });

  it('丢弃 HTML 注释与 DOCTYPE', () => {
    expect(sanitizeRichText('<!-- evil --><p>x</p>')).toBe('<p>x</p>');
    expect(sanitizeRichText('<!DOCTYPE html><p>x</p>')).toBe('<p>x</p>');
  });

  it('文本节点转义裸 & 与尖括号，但保留既有合法实体', () => {
    expect(sanitizeRichText('<p>a & b</p>')).toBe('<p>a &amp; b</p>');
    expect(sanitizeRichText('<p>&amp; &lt; &nbsp;</p>')).toBe('<p>&amp; &lt; &nbsp;</p>');
    expect(sanitizeRichText('<p>1 < 2</p>')).toBe('<p>1 &lt; 2</p>');
  });

  it('畸形标签不会重新组装出可执行标签', () => {
    const cases = [
      '<<script>alert(1)//<</script>',
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<img src="x" onerror="alert(1)" <script>',
      '<a href="javascript:alert(1)">x</a href>',
    ];
    for (const input of cases) {
      const out = sanitizeRichText(input);
      expect(out.toLowerCase()).not.toContain('<script');
      expect(out.toLowerCase()).not.toContain('javascript:');
      expect(out.toLowerCase()).not.toContain('onerror');
    }
  });

  it('白名单外的普通标签被丢弃但保留内部文本', () => {
    expect(sanitizeRichText('<marquee>hi</marquee>')).toBe('hi');
    expect(sanitizeRichText('<body onload="alert(1)">hi</body>')).toBe('hi');
    expect(sanitizeRichText('<blink>x</blink>')).toBe('x');
  });

  it('文档外壳（html/head/body）被丢弃但正文保留 —— 兼容从 Word/网页粘贴', () => {
    expect(sanitizeRichText('<html><body><p>x</p></body></html>')).toBe('<p>x</p>');
    expect(
      sanitizeRichText('<html><head><title>t</title><meta charset="utf-8"></head><body><h1>H</h1></body></html>'),
    ).toBe('<h1>H</h1>');
  });

  it('危险空元素（meta/link/base）只丢自身，不吞掉后续正文', () => {
    expect(sanitizeRichText('<meta charset="utf-8"><p>keep</p>')).toBe('<p>keep</p>');
    expect(sanitizeRichText('<link rel="stylesheet" href="x.css"><p>keep</p>')).toBe('<p>keep</p>');
    expect(sanitizeRichText('<base href="https://evil.test/"><p>keep</p>')).toBe('<p>keep</p>');
    expect(sanitizeRichText('<input type="text"><p>keep</p>')).toBe('<p>keep</p>');
  });

  it('非字符串输入返回空串', () => {
    expect(sanitizeRichText(null)).toBe('');
    expect(sanitizeRichText(undefined)).toBe('');
    expect(sanitizeRichText(123)).toBe('');
    expect(sanitizeRichText('')).toBe('');
  });
});

/* ============================ 测试夹具 ============================ */

const CATEGORY_ID = 'cat-1';
const TAG_ID_1 = 'tag-1';
const TAG_ID_2 = 'tag-2';
const MEDIA_ID = 'media-1';
const MEDIA_URL = 'http://127.0.0.1:4000/uploads/media/2026/10/cover.png';
const AUTHOR_ID = 'admin-1';

function makePrismaMock() {
  return {
    blogPost: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      groupBy: jest.fn(),
    },
    blogCategory: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    blogTag: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    blogPostTag: {
      count: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      groupBy: jest.fn(),
    },
    mediaAsset: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
    contentDraft: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    contentRevision: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), create: jest.fn(), findMany: jest.fn() },
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

/** 交互式事务：把 mock 自身当作 tx 传入回调；数组形式则 Promise.all */
function wireTransaction(prisma: PrismaMock): void {
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: PrismaMock) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
}

function makePostRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    title: '板材出口指南',
    slug: 'plywood-export-guide',
    excerpt: '摘要',
    content: '<p>正文</p>',
    coverImageUrl: MEDIA_URL,
    coverMediaId: MEDIA_ID,
    categoryId: CATEGORY_ID,
    status: PostStatus.DRAFT,
    featured: false,
    publishedAt: null,
    authorId: AUTHOR_ID,
    seoTitle: 'SEO 标题',
    seoDescription: 'SEO 描述',
    seoKeywords: 'plywood,export',
    canonicalUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    twitterTitle: null,
    twitterDescription: null,
    createdAt: NOW,
    updatedAt: NOW,
    category: { id: CATEGORY_ID, name: '行业资讯', slug: 'news' },
    author: { id: AUTHOR_ID, name: 'Admin' },
    coverMedia: { id: MEDIA_ID, url: MEDIA_URL, altText: null, width: 640, height: 480 },
    tags: [{ postId: 'post-1', tagId: TAG_ID_1, createdAt: NOW, tag: { id: TAG_ID_1, name: '出口', slug: 'export' } }],
    ...overrides,
  } as never;
}

/* ============================ 2. BlogPost 服务 ============================ */

describe('BlogPostsService（unit）', () => {
  let prisma: PrismaMock;
  let service: BlogPostsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    wireTransaction(prisma);
    service = new BlogPostsService(
      prisma as unknown as PrismaService,
      makeRevalidationMock(),
    );
  });

  /* ------------------------- 列表 ------------------------- */

  it('list：keyword / status / categoryId / tagId / featured 进入 where', async () => {
    prisma.blogPost.count.mockResolvedValue(0);
    prisma.blogPost.findMany.mockResolvedValue([]);

    await service.list({
      keyword: 'plywood',
      status: PostStatus.PUBLISHED,
      categoryId: CATEGORY_ID,
      tagId: TAG_ID_1,
      featured: true,
    } as ListBlogPostsQueryDto);

    expect(prisma.blogPost.count).toHaveBeenCalledWith({
      where: {
        status: PostStatus.PUBLISHED,
        categoryId: CATEGORY_ID,
        featured: true,
        tags: { some: { tagId: TAG_ID_1 } },
        OR: [
          { title: { contains: 'plywood', mode: 'insensitive' } },
          { slug: { contains: 'plywood', mode: 'insensitive' } },
          { excerpt: { contains: 'plywood', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('list：分页参数夹紧（page≥1，limit≤100）并返回信封', async () => {
    prisma.blogPost.count.mockResolvedValue(42);
    prisma.blogPost.findMany.mockResolvedValue([makePostRow()]);

    const result = await service.list({ page: 0, limit: 500 } as ListBlogPostsQueryDto);

    expect(prisma.blogPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 100 }),
    );
    expect(result).toMatchObject({ total: 42, page: 1, limit: 100, totalPages: 1 });
    expect(result.items[0]).toMatchObject({ id: 'post-1', tags: [{ id: TAG_ID_1, slug: 'export' }] });
  });

  it('findById：不存在 404；存在返回详情（含 SEO / OG 字段）', async () => {
    prisma.blogPost.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);

    prisma.blogPost.findUnique.mockResolvedValue(makePostRow());
    const dto = await service.findById('post-1');
    expect(dto).toMatchObject({
      id: 'post-1',
      seoTitle: 'SEO 标题',
      seoKeywords: 'plywood,export',
      tagIds: [TAG_ID_1],
      coverMedia: { id: MEDIA_ID, url: MEDIA_URL },
      category: { id: CATEGORY_ID, slug: 'news' },
    });
  });

  /* ------------------------- 创建 ------------------------- */

  it('create：净化正文、默认 DRAFT、publishedAt=null、封面快照与标签写入', async () => {
    prisma.blogCategory.findUnique.mockResolvedValue({ id: CATEGORY_ID });
    prisma.mediaAsset.findUnique.mockResolvedValue({ id: MEDIA_ID, url: MEDIA_URL });
    prisma.blogTag.findMany.mockResolvedValue([{ id: TAG_ID_1 }, { id: TAG_ID_2 }]);
    prisma.blogPost.create.mockResolvedValue(makePostRow());

    await service.create(
      {
        title: '板材出口指南',
        slug: 'plywood-export-guide',
        content: '<p>正文</p><script>alert(1)</script>',
        categoryId: CATEGORY_ID,
        coverMediaId: MEDIA_ID,
        tagIds: [TAG_ID_1, TAG_ID_2],
      } as CreateBlogPostDto,
      AUTHOR_ID,
    );

    const arg = prisma.blogPost.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.content).toBe('<p>正文</p>'); // script 已剔除
    expect(arg.data.status).toBe(PostStatus.DRAFT);
    expect(arg.data.publishedAt).toBeNull();
    expect(arg.data.featured).toBe(false);
    expect(arg.data.authorId).toBe(AUTHOR_ID);
    expect(arg.data.coverImageUrl).toBe(MEDIA_URL); // 快照同步
    expect(arg.data.tags).toEqual({ create: [{ tagId: TAG_ID_1 }, { tagId: TAG_ID_2 }] });
  });

  it('create：即使调用方传入 status=PUBLISHED 也强制落为 DRAFT', async () => {
    prisma.blogPost.create.mockResolvedValue(makePostRow());

    await service.create(
      { title: '发布稿', slug: 'published-post', content: '<p>x</p>', status: PostStatus.PUBLISHED } as unknown as CreateBlogPostDto,
      null,
    );

    const arg = prisma.blogPost.create.mock.calls[0][0] as {
      data: { publishedAt: Date | null; status: PostStatus };
    };
    expect(arg.data.status).toBe(PostStatus.DRAFT);
    expect(arg.data.publishedAt).toBeNull();
  });

  it('create：显式 publishedAt 被忽略（发布时间只能由 publish 写入）', async () => {
    prisma.blogPost.create.mockResolvedValue(makePostRow());
    const explicit = '2026-01-02T03:04:05.000Z';

    await service.create(
      {
        title: '定时发布',
        slug: 'scheduled-post',
        content: '<p>x</p>',
        publishedAt: explicit,
      } as unknown as CreateBlogPostDto,
      null,
    );

    const arg = prisma.blogPost.create.mock.calls[0][0] as { data: { publishedAt: Date | null } };
    expect(arg.data.publishedAt).toBeNull();
  });

  it('create：分类不存在 → 400', async () => {
    prisma.blogCategory.findUnique.mockResolvedValue(null);
    await expect(
      service.create(
        { title: 'x', slug: 'x-1', content: '<p>x</p>', categoryId: 'nope' } as CreateBlogPostDto,
        null,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.blogPost.create).not.toHaveBeenCalled();
  });

  it('create：封面媒体不存在 → 400（禁止引用媒体库之外的资源）', async () => {
    prisma.mediaAsset.findUnique.mockResolvedValue(null);
    await expect(
      service.create(
        { title: 'x', slug: 'x-1', content: '<p>x</p>', coverMediaId: 'nope' } as CreateBlogPostDto,
        null,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.blogPost.create).not.toHaveBeenCalled();
  });

  it('create：标签不存在 → 400 并指出缺失 id', async () => {
    prisma.blogTag.findMany.mockResolvedValue([{ id: TAG_ID_1 }]);
    await expect(
      service.create(
        { title: 'x', slug: 'x-1', content: '<p>x</p>', tagIds: [TAG_ID_1, 'missing-tag'] } as CreateBlogPostDto,
        null,
      ),
    ).rejects.toThrow('标签不存在: missing-tag');
  });

  it('create：slug 唯一冲突 → 409', async () => {
    const { Prisma } = await import('@prisma/client');
    prisma.blogPost.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.create({ title: 'x', slug: 'dup-slug', content: '<p>x</p>' } as CreateBlogPostDto, null),
    ).rejects.toThrow(ConflictException);
  });

  /* ------------------------- 更新 ------------------------- */

  it('update：不存在 → 404', async () => {
    prisma.blogPost.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { title: 'y' } as UpdateBlogPostDto)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('update：三态语义 —— 未提供的字段不变，提供 null 则置空', async () => {
    prisma.blogPost.findUnique.mockResolvedValue({
      id: 'post-1',
      status: PostStatus.DRAFT,
      publishedAt: null,
    });
    prisma.blogPost.update.mockResolvedValue(makePostRow());

    await service.update('post-1', {
      title: '新标题',
      excerpt: null,
      seoTitle: null,
      canonicalUrl: 'https://bailingwooden.com/blog/plywood-export-guide',
    } as UpdateBlogPostDto);

    const arg = prisma.blogPost.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.title).toBe('新标题');
    expect(arg.data.excerpt).toBeNull();
    expect(arg.data.seoTitle).toBeNull();
    expect(arg.data.canonicalUrl).toBe('https://bailingwooden.com/blog/plywood-export-guide');
    // 未提供的字段不应出现在 update data 中
    expect('seoDescription' in arg.data).toBe(false);
    expect('slug' in arg.data).toBe(false);
  });

  it('update：tagIds 提供时先清空旧关联再写入新关联', async () => {
    prisma.blogPost.findUnique.mockResolvedValue({ id: 'post-1', status: PostStatus.DRAFT, publishedAt: null });
    prisma.blogTag.findMany.mockResolvedValue([{ id: TAG_ID_2 }]);
    prisma.blogPost.update.mockResolvedValue(makePostRow());

    await service.update('post-1', { tagIds: [TAG_ID_2] } as UpdateBlogPostDto);

    expect(prisma.blogPostTag.deleteMany).toHaveBeenCalledWith({ where: { postId: 'post-1' } });
    expect(prisma.blogPostTag.createMany).toHaveBeenCalledWith({
      data: [{ postId: 'post-1', tagId: TAG_ID_2 }],
    });
  });

  it('update：tagIds=[] 只清空关联、不写入', async () => {
    prisma.blogPost.findUnique.mockResolvedValue({ id: 'post-1', status: PostStatus.DRAFT, publishedAt: null });
    prisma.blogPost.update.mockResolvedValue(makePostRow({ tags: [] }));

    await service.update('post-1', { tagIds: [] } as UpdateBlogPostDto);

    expect(prisma.blogPostTag.deleteMany).toHaveBeenCalled();
    expect(prisma.blogPostTag.createMany).not.toHaveBeenCalled();
  });

  it('update：coverMediaId=null 断开封面并清空快照', async () => {
    prisma.blogPost.findUnique.mockResolvedValue({ id: 'post-1', status: PostStatus.DRAFT, publishedAt: null });
    prisma.blogPost.update.mockResolvedValue(makePostRow({ coverMediaId: null, coverImageUrl: null, coverMedia: null }));

    await service.update('post-1', { coverMediaId: null } as UpdateBlogPostDto);

    const arg = prisma.blogPost.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.coverMedia).toEqual({ disconnect: true });
    expect(arg.data.coverImageUrl).toBeNull();
  });

  it('update：不改动 status / publishedAt（发布态只能经 publish/unpublish）', async () => {
    prisma.blogPost.findUnique.mockResolvedValue({ id: 'post-1', status: PostStatus.DRAFT, publishedAt: null });
    prisma.blogPost.update.mockResolvedValue(makePostRow());

    await service.update('post-1', { status: PostStatus.PUBLISHED } as unknown as UpdateBlogPostDto);

    const arg = prisma.blogPost.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect('status' in arg.data).toBe(false);
    expect('publishedAt' in arg.data).toBe(false);
  });

  it('update：内容更新时同样经净化', async () => {
    prisma.blogPost.findUnique.mockResolvedValue({ id: 'post-1', status: PostStatus.DRAFT, publishedAt: null });
    prisma.blogPost.update.mockResolvedValue(makePostRow());

    await service.update('post-1', { content: '<img src="x" onerror="alert(1)">' } as UpdateBlogPostDto);

    const arg = prisma.blogPost.update.mock.calls[0][0] as { data: { content: string } };
    expect(arg.data.content).toBe('<img src="x">');
  });

  /* ------------------------- 删除 ------------------------- */

  it('remove：不存在 404；存在返回 {id}', async () => {
    prisma.blogPost.findUnique.mockResolvedValue(null);
    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);

    prisma.blogPost.findUnique.mockResolvedValue({ id: 'post-1' });
    prisma.blogPost.delete.mockResolvedValue(makePostRow());
    await expect(service.remove('post-1')).resolves.toEqual({ id: 'post-1' });
    expect(prisma.blogPost.delete).toHaveBeenCalledWith({ where: { id: 'post-1' } });
  });
});

/* ============================ 3. 分类服务 ============================ */

describe('BlogCategoriesService（unit）', () => {
  let prisma: PrismaMock;
  let service: BlogCategoriesService;

  const categoryRow = {
    id: CATEGORY_ID,
    name: '行业资讯',
    slug: 'news',
    description: 'desc',
    sortOrder: 1,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new BlogCategoriesService(
      prisma as unknown as PrismaService,
      makeRevalidationMock(),
    );
  });

  it('list：按 sortOrder 升序返回并附带文章计数', async () => {
    prisma.blogCategory.findMany.mockResolvedValue([categoryRow]);
    prisma.blogPost.groupBy.mockResolvedValue([{ categoryId: CATEGORY_ID, _count: { _all: 3 } }]);

    const result = await service.list();

    expect(prisma.blogCategory.findMany).toHaveBeenCalledWith({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    expect(result[0]).toMatchObject({ id: CATEGORY_ID, postCount: 3, isActive: true });
  });

  it('create：默认 sortOrder=0 / isActive=true', async () => {
    prisma.blogCategory.create.mockResolvedValue(categoryRow);

    await service.create({ name: '行业资讯', slug: 'news' });

    expect(prisma.blogCategory.create).toHaveBeenCalledWith({
      data: {
        name: '行业资讯',
        slug: 'news',
        description: null,
        sortOrder: 0,
        isActive: true,
      },
    });
  });

  it('update：支持禁用（isActive=false）与部分更新；不存在 404', async () => {
    prisma.blogCategory.findUnique.mockResolvedValue({ id: CATEGORY_ID });
    prisma.blogCategory.update.mockResolvedValue({ ...categoryRow, isActive: false });
    prisma.blogPost.count.mockResolvedValue(0);

    const dto = await service.update(CATEGORY_ID, { isActive: false });
    expect(dto.isActive).toBe(false);

    prisma.blogCategory.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { name: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('remove：有文章时拒绝（400）且不删除', async () => {
    prisma.blogCategory.findUnique.mockResolvedValue({ id: CATEGORY_ID });
    prisma.blogPost.count.mockResolvedValue(2);

    await expect(service.remove(CATEGORY_ID)).rejects.toThrow(BadRequestException);
    expect(prisma.blogCategory.delete).not.toHaveBeenCalled();
  });

  it('remove：无文章时删除成功；不存在 404', async () => {
    prisma.blogCategory.findUnique.mockResolvedValue({ id: CATEGORY_ID });
    prisma.blogPost.count.mockResolvedValue(0);
    prisma.blogCategory.delete.mockResolvedValue(categoryRow);

    await expect(service.remove(CATEGORY_ID)).resolves.toEqual({ id: CATEGORY_ID });

    prisma.blogCategory.findUnique.mockResolvedValue(null);
    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
  });

  it('create：slug 冲突 → 409', async () => {
    const { Prisma } = await import('@prisma/client');
    prisma.blogCategory.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );
    await expect(service.create({ name: 'x', slug: 'dup' })).rejects.toThrow(ConflictException);
  });
});

/* ============================ 4. 标签服务 ============================ */

describe('BlogTagsService（unit）', () => {
  let prisma: PrismaMock;
  let service: BlogTagsService;

  const tagRow = { id: TAG_ID_1, name: '出口', slug: 'export', createdAt: NOW };

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new BlogTagsService(
      prisma as unknown as PrismaService,
      makeRevalidationMock(),
    );
  });

  it('list：按名称升序返回并附带引用计数', async () => {
    prisma.blogTag.findMany.mockResolvedValue([tagRow]);
    prisma.blogPostTag.groupBy.mockResolvedValue([{ tagId: TAG_ID_1, _count: { _all: 5 } }]);

    const result = await service.list();

    expect(prisma.blogTag.findMany).toHaveBeenCalledWith({ orderBy: [{ name: 'asc' }] });
    expect(result[0]).toMatchObject({ id: TAG_ID_1, postCount: 5 });
  });

  it('create：仅写 name / slug', async () => {
    prisma.blogTag.create.mockResolvedValue(tagRow);
    await service.create({ name: '出口', slug: 'export' });
    expect(prisma.blogTag.create).toHaveBeenCalledWith({ data: { name: '出口', slug: 'export' } });
  });

  it('update：部分更新并返回最新引用计数；不存在 404', async () => {
    prisma.blogTag.findUnique.mockResolvedValue({ id: TAG_ID_1 });
    prisma.blogTag.update.mockResolvedValue({ ...tagRow, name: '出口贸易' });
    prisma.blogPostTag.count.mockResolvedValue(2);

    const dto = await service.update(TAG_ID_1, { name: '出口贸易' });
    expect(dto).toMatchObject({ name: '出口贸易', postCount: 2 });

    prisma.blogTag.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { name: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('remove：删除成功（关联由 schema 级联移除）；不存在 404', async () => {
    prisma.blogTag.findUnique.mockResolvedValue({ id: TAG_ID_1 });
    prisma.blogTag.delete.mockResolvedValue(tagRow);

    await expect(service.remove(TAG_ID_1)).resolves.toEqual({ id: TAG_ID_1 });

    prisma.blogTag.findUnique.mockResolvedValue(null);
    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
  });
});
