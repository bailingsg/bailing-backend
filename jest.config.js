module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  testTimeout: 30000,
  // e2e 存储适配器强制 LOCAL（不写真实 COS 桶），详见 test/jest.setup.ts
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // e2e 套件共用同一个 PostgreSQL 库（各文件的 beforeAll 会互相读写同一批表），
  // 并行执行会出现「统计接口读到别套件刚插入的数据」这类抖动。
  // 因此强制串行：宁可慢一点，也要结果可复现。
  maxWorkers: 1,
};
