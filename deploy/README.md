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

Note: a host IP is not treated as a local endpoint, so when you switch to one you
must also set `LLM_API_KEY` in `.env.docker` to a real (non-empty, non-placeholder)
value — otherwise the backend fails startup with `LLM_API_KEY must be set to a
non-placeholder value for non-local LLM endpoints`. Any other non-empty value works
if your gateway does not check keys.
