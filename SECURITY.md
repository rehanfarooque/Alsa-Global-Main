# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

Only the latest version on the `main` branch is actively maintained and receives security updates.

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in AlsaGlobal, please report it responsibly:

1. **GitHub Private Vulnerability Reporting**: Use [GitHub's private vulnerability reporting](https://github.com/rehanfarooque/Alsa-Global/security/advisories/new) to submit your report directly through the repository.

2. **Direct Contact**: Alternatively, reach out via the repository owner's GitHub profile at [@rehanfarooque](https://github.com/rehanfarooque).

### What to Include

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Affected components (API handlers, client-side code, data layers, etc.)
- Any potential fixes or mitigations you've identified

### Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial Assessment**: Within 1 week
- **Fix/Patch**: Depending on severity, critical issues will be prioritized

### What to Expect

- You will receive an acknowledgment of your report
- We will work with you to understand and validate the issue
- We will keep you informed of progress toward a fix
- Credit will be given to reporters in the fix commit (unless you prefer anonymity)

## Security Considerations

AlsaGlobal is a web intelligence dashboard that aggregates publicly available data. Here are the key security areas:

### API Keys & Secrets

- API keys are stored server-side and never exposed to the client
- No API keys should ever be committed to the repository
- Environment variables (`.env`) are gitignored — use `.env.example` as a template
- The RSS proxy uses domain allowlisting to prevent SSRF

### API Handlers & Sebuf

- All domain APIs are served through Sebuf (a Proto-first RPC framework)
- Handlers validate and sanitize all input
- CORS headers are configured per-function
- Rate limiting and circuit breakers protect against abuse

### Client-Side Security

- No sensitive data is stored in localStorage or sessionStorage
- External content (RSS feeds, news) is sanitized before rendering
- Map data layers use trusted, vetted data sources
- Content Security Policy restricts script-src to `'self'`

### Data Sources

- AlsaGlobal aggregates publicly available OSINT data
- No classified or restricted data sources are used
- State-affiliated sources are flagged with propaganda risk ratings
- All data is consumed read-only — the platform does not modify upstream sources

## Scope

The following are **in scope** for security reports:

- Vulnerabilities in the AlsaGlobal codebase
- API handler security issues (SSRF, injection, auth bypass)
- XSS or content injection through RSS feeds or external data
- API key exposure or secret leakage
- Dependency vulnerabilities with a viable attack vector

The following are **out of scope**:

- Vulnerabilities in third-party services we consume (report to the upstream provider)
- Social engineering attacks
- Denial of service attacks
- Issues in forked copies of the repository
- Security issues in user-provided environment configurations

## Best Practices for Contributors

- Never commit API keys, tokens, or secrets
- Use environment variables for all sensitive configuration
- Sanitize external input in handlers
- Keep dependencies updated — run `npm audit` regularly
- Follow the principle of least privilege for API access

---

Thank you for helping keep AlsaGlobal and its users safe.
