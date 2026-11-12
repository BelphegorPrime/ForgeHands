# Security policy

Please do not disclose vulnerabilities in public issues. Contact the maintainers privately through GitHub's private vulnerability reporting if enabled.

The webhook endpoint accepts untrusted input and must be protected with TLS, an unguessable secret, and a network/host firewall. ForgeHands has no need for a Docker socket or any Forgejo git-write token. Only grant OpenHands permissions for repositories in scope.
