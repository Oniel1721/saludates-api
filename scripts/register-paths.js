// Registers path aliases for start:dev (tsc-alias only runs on build)
const { register } = require('tsconfig-paths');
register({ baseUrl: './dist', paths: { '@/*': ['src/*'] } });
