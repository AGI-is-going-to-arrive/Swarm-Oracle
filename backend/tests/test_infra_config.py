from fnmatch import fnmatchcase
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE_INSTRUCTION_NAMES = frozenset(
    {
        "ADD",
        "ARG",
        "CMD",
        "COPY",
        "ENTRYPOINT",
        "ENV",
        "EXPOSE",
        "FROM",
        "HEALTHCHECK",
        "LABEL",
        "MAINTAINER",
        "ONBUILD",
        "RUN",
        "SHELL",
        "STOPSIGNAL",
        "USER",
        "VOLUME",
        "WORKDIR",
    }
)


def read_repo_file(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def dockerignore_ignores(dockerignore: str, relative_path: str) -> bool:
    ignored = False
    for raw_line in dockerignore.splitlines():
        rule = raw_line.strip()
        if not rule or rule.startswith("#"):
            continue
        negated = rule.startswith("!")
        pattern = rule[1:] if negated else rule
        pattern = pattern.lstrip("/")
        if fnmatchcase(relative_path, pattern):
            ignored = not negated
    return ignored


def dockerfile_instructions(dockerfile: str) -> list[tuple[str, str]]:
    instructions: list[tuple[str, str]] = []
    logical_line = ""
    for raw_line in dockerfile.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        logical_line = f"{logical_line[:-1].rstrip()} {line}".strip() if logical_line else line
        if logical_line.endswith("\\"):
            continue
        parts = logical_line.split(maxsplit=1)
        logical_line = ""
        if len(parts) == 2 and parts[0].upper() in DOCKERFILE_INSTRUCTION_NAMES:
            instructions.append((parts[0].upper(), parts[1]))
    return instructions


def runtime_dockerfile_instructions(dockerfile: str) -> list[tuple[str, str]]:
    runtime_instructions: list[tuple[str, str]] = []
    in_runtime_stage = False
    for instruction, value in dockerfile_instructions(dockerfile):
        if instruction == "FROM":
            parts = value.split()
            in_runtime_stage = (
                len(parts) >= 3
                and parts[-2].upper() == "AS"
                and parts[-1].lower() == "runtime"
            )
        elif in_runtime_stage:
            runtime_instructions.append((instruction, value))
    return runtime_instructions


def last_dockerfile_instruction_value(
    instructions: list[tuple[str, str]],
    instruction: str,
) -> str | None:
    expected_instruction = instruction.upper()
    return next(
        (
            value
            for parsed_instruction, value in reversed(instructions)
            if parsed_instruction == expected_instruction
        ),
        None,
    )


def test_dockerignore_matching_uses_the_last_matching_rule():
    mutated_dockerignore = ".env*\n**/.env*\n!backend/**\n"

    assert dockerignore_ignores(mutated_dockerignore, ".env.docker")
    assert not dockerignore_ignores(mutated_dockerignore, "backend/.env")
    assert dockerignore_ignores(mutated_dockerignore, "frontend/.env.local")


def test_dockerignore_root_rule_does_not_match_nested_paths():
    root_only_dockerignore = ".env*\n"

    assert dockerignore_ignores(root_only_dockerignore, ".env.docker")
    assert not dockerignore_ignores(root_only_dockerignore, "frontend/.env.local")


def test_dockerfile_instruction_parser_uses_the_last_effective_user():
    mutated_dockerfile = (
        "FROM python:3.13-slim AS runtime\n"
        "USER appuser\n"
        "# USER nobody\n"
        "RUN true\n"
        "user root\n"
    )
    runtime_instructions = runtime_dockerfile_instructions(mutated_dockerfile)

    assert last_dockerfile_instruction_value(runtime_instructions, "USER") == "root"


def test_runtime_dockerfile_parser_ignores_commented_contract_text():
    mutated_dockerfile = (
        "FROM python:3.13-slim AS builder\n"
        "COPY packs/ /app/packs/\n"
        "FROM python:3.13-slim AS runtime\n"
        "WORKDIR /app/backend\n"
        "# COPY packs/ /app/packs/\n"
        "metadata COPY packs/ /app/packs/\n"
        "# RUN chown -R appuser:appuser /app /data\n"
        "metadata RUN chown -R appuser:appuser /app /data\n"
        "USER appuser\n"
    )

    assert runtime_dockerfile_instructions(mutated_dockerfile) == [
        ("WORKDIR", "/app/backend"),
        ("USER", "appuser"),
    ]


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


def test_docker_context_excludes_env_files_at_every_depth():
    dockerignore = read_repo_file(".dockerignore")
    dockerfile = read_repo_file("backend/Dockerfile")

    for relative_path in (".env.docker", "backend/.env", "frontend/.env.local"):
        assert dockerignore_ignores(dockerignore, relative_path), relative_path
    assert ".env" not in dockerfile


def test_backend_runtime_image_bundles_default_local_content_for_non_root_user():
    dockerfile = read_repo_file("backend/Dockerfile")
    config = read_repo_file("backend/app/config.py")
    runtime_instructions = runtime_dockerfile_instructions(dockerfile)
    runtime_workdir = last_dockerfile_instruction_value(runtime_instructions, "WORKDIR")

    assert runtime_workdir == "/app/backend"
    assert "BACKEND_ROOT = Path(__file__).resolve().parents[1]" in config
    assert "REPO_ROOT = BACKEND_ROOT.parent" in config
    assert (
        'PACKS_DIR: Path = Field(default_factory=lambda: (REPO_ROOT / "packs").resolve())'
        in config
    )
    assert (
        'SAMPLES_DIR: Path = Field(default_factory=lambda: (REPO_ROOT / "samples").resolve())'
        in config
    )

    container_packs_dir = Path(runtime_workdir).parent / "packs"
    container_samples_dir = Path(runtime_workdir).parent / "samples"
    content_copy_indexes = {
        source: [
            index
            for index, (instruction, value) in enumerate(runtime_instructions)
            if instruction == "COPY" and value == f"{source}/ {destination.as_posix()}/"
        ]
        for source, destination in (
            ("packs", container_packs_dir),
            ("samples", container_samples_dir),
        )
    }
    ownership_indexes = [
        index
        for index, (instruction, value) in enumerate(runtime_instructions)
        if instruction == "RUN" and "chown -R appuser:appuser /app /data" in value
    ]
    user_indexes = [
        index
        for index, (instruction, _) in enumerate(runtime_instructions)
        if instruction == "USER"
    ]

    assert all(content_copy_indexes.values())
    assert ownership_indexes
    assert user_indexes
    assert all(
        indexes[-1] < ownership_indexes[-1] < user_indexes[-1]
        for indexes in content_copy_indexes.values()
    )
    assert last_dockerfile_instruction_value(runtime_instructions, "USER") == "appuser"


def test_docker_compose_keeps_localhost_ports_and_host_llm_access():
    compose = read_repo_file("docker-compose.yml")

    assert "- HOST=0.0.0.0" in compose
    assert '"127.0.0.1:18927:18927"' in compose
    assert '"127.0.0.1:18928:80"' in compose
    assert '"host.docker.internal:host-gateway"' in compose


def test_deploy_readme_documents_native_linux_host_gateway_fallbacks():
    deploy_readme = read_repo_file("deploy/README.md").lower()

    assert "native linux" in deploy_readme
    assert "host.docker.internal" in deploy_readme
    assert "host-gateway" in deploy_readme
    assert "llm_responses_url" in deploy_readme
    assert "host's actual ip" in deploy_readme
    assert "network_mode: host" in deploy_readme
