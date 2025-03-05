export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
    }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@elizaos/core$': '<rootDir>/test/__mocks__/@elizaos/core.ts'
  },
  // Tell Jest to use the mock directory
  moduleDirectories: ['node_modules', 'test/__mocks__'],
  // Automatically mock certain modules
  automock: false,
  // Clear mocks before each test
  clearMocks: true,
  // The directory where Jest should output its coverage files
  coverageDirectory: "coverage",
  // Indicates whether the coverage information should be collected while executing the test
  collectCoverage: false,
};
