# Agent instructions

## Cursor Cloud specific instructions

- This is a serverless TypeScript AWS Lambda service, not a web app with a local HTTP dev server. Standard commands live in `package.json` and the README; `npm run build:watch` is the closest local development run mode for keeping `dist/` current.
- Full end-to-end invoice/supplier processing depends on a real Workday tenant plus AWS/OpenAI-backed infrastructure (`OPENAI_API_KEY`, Workday OAuth config, AWS credentials/region, database/S3 stack values). In Cloud VMs without those values, use the mocked Jest suite and local RAG/supplier-content smoke checks for safe validation.
