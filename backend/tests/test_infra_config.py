from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def read_repo_file(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def test_ci_has_required_windows_and_macos_frontend_script_coverage():
    workflow = read_repo_file(".github/workflows/ci.yml")

    assert "cross-platform-frontend-smoke:" in workflow
    assert "windows-latest" in workflow
    assert "macos-latest" in workflow
    assert "continue-on-error" not in workflow
    assert "node scripts/release-signoff.mjs --dry-run" in workflow
    assert "--skip-backend-checks --skip-assets-check --headless" in workflow
    assert "closePlaywrightBrowser" in workflow
    assert "node --test" in workflow
    assert "scripts/e2e-frontend-preflight.test.mjs" in workflow


def test_docker_compose_keeps_linux_host_gateway_mapping():
    compose = read_repo_file("docker-compose.yml")

    assert "extra_hosts:" in compose
    assert "host.docker.internal:host-gateway" in compose
    assert "Linux needs host-gateway support or an explicit host IP" in compose


def test_deploy_readme_documents_native_linux_host_gateway_fallbacks():
    deploy_readme = read_repo_file("deploy/README.md").lower()

    assert "native linux" in deploy_readme
    assert "host.docker.internal" in deploy_readme
    assert "host-gateway" in deploy_readme
    assert "llm_responses_url" in deploy_readme
    assert "host's actual ip" in deploy_readme
    assert "network_mode: host" in deploy_readme
