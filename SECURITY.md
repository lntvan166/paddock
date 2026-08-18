# Security

## The model, in one paragraph

paddock runs on the same machine as herdr, binds `127.0.0.1:8787`, and has **no
authentication of its own**. That is deliberate — an application token would
also gate `/sw.js` and silently disable the service worker and push (see
[`docs/decisions.md`](docs/decisions.md)). Access control is expected to live in
front of it: a Cloudflare Tunnel with Zero Trust Access, a WireGuard mesh, or
an equivalent that authenticates the request **before** paddock sees it.

## What an exposed instance gives away

Anyone who can reach the port can:

- read everything on every agent's screen, including secrets an agent printed
- send arbitrary keystrokes and text to any agent
- answer permission prompts — including *"and don't ask again"* grants

There is no login to stop them. **Do not port-forward `8787`, and do not bind
it to `0.0.0.0`.**

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/lntvan166/paddock/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps; a working exploit is not required.

This is a personal project with no SLA. Expect a first response within a week.

## Scope

In scope: anything that lets a request reach agent control without passing the
operator's chosen access layer, and anything that leaks agent output beyond the
intended reader.

Out of scope: exposing the port deliberately without an access layer in front —
that is documented above as unsafe rather than a defect.
