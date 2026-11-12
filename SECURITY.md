# Security policy

## Supported versions

Security fixes are released for the latest 1.x version of the hybld packages. Upgrade to the newest patch release before reporting.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's Security tab and choose "Report a vulnerability". Include the affected package and version, what an attacker can do, and the smallest reproduction you can share.

You can expect an acknowledgement within five working days. Once a fix is released, the report is credited in the changelog unless you ask otherwise.

## Scope notes

Areas where reports are most useful:

- `hybld serve`: the webhook and rebuild endpoints, the shared-secret check, static file resolution and regeneration on miss.
- Output path handling: routes or CMS-supplied values that could write outside the output directory.
- CMS adapters: handling of credentials, and the on-disk response cache.

`hybld serve` binds to `127.0.0.1` by default and refuses to start on a public interface without a secret unless `--insecure` is passed. Deployments that expose it should sit behind TLS and set `--secret`.
