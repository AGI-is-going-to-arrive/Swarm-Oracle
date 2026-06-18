# Deploy Notes

## Docker Compose and Host LLM Endpoints on Native Linux

`docker-compose.yml` maps `host.docker.internal` to Docker's `host-gateway` so
the backend container can reach an LLM gateway running on the host, for example:

```env
LLM_RESPONSES_URL=http://host.docker.internal:8318/v1/chat/completions
```

Docker Desktop on macOS and Windows resolves `host.docker.internal` by default.
On native Linux, Docker must support the `host-gateway` mapping. If
`host.docker.internal` still does not resolve from inside the container, keep the
same application settings but point `LLM_RESPONSES_URL` at the host's actual IP,
or run a Linux-only override with `network_mode: host`.
