# Contributing

Issues and focused pull requests are welcome.

Before submitting a change:

```bash
npm install
npm run check
```

Keep the v0.1 safety model intact: repository paths must remain fixed at server startup, Git calls must not use a shell or user-provided argument arrays, and new persistence paths must pass through redaction and sensitive-path filtering.

For behavior changes, add an integration test using a temporary Git repository. For new MCP tools, explain why the behavior cannot fit one of the existing ten tools; a small and predictable tool surface is a product constraint.
