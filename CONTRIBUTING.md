# Contributing to Finance Agent

Thank you for your interest in contributing. This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (SPDX: `AGPL-3.0-or-later`) and is maintained by the PGA of America.

## Contributor License Agreement

Before we can accept a contribution, you (or your employer) must agree to the [Individual Contributor License Agreement](CLA.md).

### How to sign the CLA

1. Read the full text of [CLA.md](CLA.md).
2. Email [legal@pgahq.com](mailto:legal@pgahq.com) with:
   - The subject line: `Finance Agent CLA — <your GitHub username>`
   - Your full legal name
   - Your GitHub username
   - Your employer name (if contributing on behalf of an employer)
   - A statement that you agree to the Individual Contributor License Agreement in `CLA.md`
3. Wait for confirmation from the PGA of America Legal Department before opening or updating a pull request.

Contributions from authors without a signed CLA on file will not be merged.

## Pull request process

1. Open an issue to discuss substantial changes before starting large work.
2. Fork the repository and create a feature branch from `main`.
3. Make your changes with tests where appropriate.
4. Run quality checks locally:

```bash
npm install
npm run lint
npm test
npm run build
```

5. Open a pull request with a clear description of the change and a link to any related issue.
6. Ensure CI passes and address review feedback.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Security

Please report security vulnerabilities as described in [SECURITY.md](SECURITY.md). Do not open public GitHub issues for security reports.

## Trademarks

The AGPL does not grant trademark rights. See [TRADEMARKS.md](TRADEMARKS.md) for the PGA of America trademark policy.
