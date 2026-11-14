# Contributing

Use Node 24 and the locked dependencies. Run the commands in [development](docs/development.md) before submitting a focused PR. Describe the concrete behavior change and validation; state any external integration that was not exercised.

Preserve the trust boundaries in [security](docs/security.md). Authorization/merge decisions belong to deterministic trusted code, credentials never belong in the model container, and PR files may not change their own review policy. Include negative tests for changes to these boundaries. Do not add dependencies, services or retries without a concrete need.

Do not include real source snapshots, tokens, keys, personal account claims or production test identifiers in fixtures/issues. Use private security reporting for vulnerabilities. Contributions are licensed under Apache-2.0.
