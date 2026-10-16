# Security Policy

DJ Llama stores credentials for the services it talks to (Plex tokens, your
Lidarr API key, AI provider keys, notification webhooks), so security reports
are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead:
the **Security** tab of this repository → **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. You
should get an acknowledgement within a week.

## Scope

DJ Llama is self-hosted software; each deployment is run by its own operator.
In scope: the application code in this repository (Plex sign-in and session
handling, authorization between users, API routes, encryption of stored
credentials, SSRF protections on outbound requests and notification webhooks).
Out of scope: a specific operator's infrastructure, reverse proxy, or
configuration choices.

## Supported versions

Only the latest `main` (and the `ghcr.io/jbuxxy/dj-llama:latest` image built
from it) receives fixes.
