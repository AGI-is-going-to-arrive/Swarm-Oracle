import json
import os
import subprocess
import textwrap
import tomllib
from fnmatch import fnmatchcase
from pathlib import Path

import yaml

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
    assert "DNS mapping only" in compose
    assert "bound solely to 127.0.0.1" in compose


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
    assert "do not apply a standalone" in deploy_readme
    assert "dns/address mapping only" in deploy_readme


def test_ghcr_publish_requires_exact_verified_sha():
    workflow = read_repo_file(".github/workflows/ghcr.yml")
    promotion_script = read_repo_file("scripts/promote-ghcr-pair.sh")
    trigger_block = workflow.split("\npermissions:", maxsplit=1)[0]
    publish_block = workflow.split("\n  publish:", maxsplit=1)[1].split(
        "\n  promote:", maxsplit=1
    )[0]
    promote_block = workflow.split("\n  promote:", maxsplit=1)[1]

    assert "workflow_run:" in trigger_block
    assert 'workflows: ["CI"]' in trigger_block
    assert "workflow_dispatch:" in trigger_block
    assert "\n  push:" not in trigger_block
    for marker in (
        "github.event.workflow_run.head_sha",
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.head_repository.full_name == github.repository",
        'select(.name == "release-signoff" and .conclusion == "success")',
        "ref: ${{ needs.verify.outputs.target_sha }}",
        "sha-${{ needs.verify.outputs.target_sha }}",
    ):
        assert marker in workflow

    assert "type=raw,value=sha-${{ needs.verify.outputs.target_sha }}" in publish_block
    assert "type=semver" not in publish_block
    assert "imagetools create" not in publish_block
    assert "concurrency:" not in publish_block

    assert "needs: [verify, publish, image-smoke]" in promote_block
    assert "matrix.component" not in promote_block
    assert "ghcr-promotion-${{ needs.verify.outputs.channel }}-" in promote_block
    assert "Revalidate freshness and promote verified image pair" in promote_block
    assert "regctl-linux-amd64" in promote_block
    assert "c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467" in promote_block
    assert "bash scripts/promote-ghcr-pair.sh" in promote_block
    assert "docker buildx imagetools create" not in promote_block

    for marker in (
        'current_main_sha="$($GH_BIN api "repos/${GITHUB_REPOSITORY}/commits/main"',
        'target_tag="edge"',
        "rollback_pair()",
        'trap on_exit EXIT',
        'tag delete --ignore-missing "${image}:${target_tag}"',
        'image copy "${image}@${old_digest}" "${image}:${target_tag}"',
        'promotion_committed="true"',
    ):
        assert marker in promotion_script

    build_index = workflow.index("Build and push immutable ${{ matrix.component }} image")
    promotion_index = workflow.index(
        "Revalidate freshness and promote verified image pair"
    )
    assert build_index < promotion_index
    assert "pattern={{major}}.{{minor}}" not in workflow


def test_final_image_pair_gate_covers_both_architectures_before_digest_promotion():
    workflow = yaml.safe_load(read_repo_file(".github/workflows/ghcr.yml"))
    smoke = workflow["jobs"]["image-smoke"]
    assert smoke["needs"] == ["verify", "publish"]
    platforms = {entry["platform"] for entry in smoke["strategy"]["matrix"]["include"]}
    assert platforms == {"linux/amd64", "linux/arm64"}
    assert "image-smoke" in workflow["jobs"]["promote"]["needs"]
    smoke_commands = "\n".join(step.get("run", "") for step in smoke["steps"])
    assert "scripts/container_smoke.py run" in smoke_commands
    assert '.image + "@" + .digest' in smoke_commands
    promotion = "\n".join(step.get("run", "") for step in workflow["jobs"]["promote"]["steps"])
    assert 'export BACKEND_DIGEST="$(jq -r .digest .image-digests/backend.json)"' in promotion
    assert 'export FRONTEND_DIGEST="$(jq -r .digest .image-digests/frontend.json)"' in promotion


def test_dependency_lock_is_universal_and_consumed_without_resolving_build_tools():
    lock = tomllib.loads(read_repo_file("backend/uv.lock"))
    project = tomllib.loads(read_repo_file("backend/pyproject.toml"))
    frontend = json.loads(read_repo_file("frontend/package.json"))
    assert lock["requires-python"] == project["project"]["requires-python"] == ">=3.11"
    assert project["tool"]["uv"]["required-version"] == "==0.12.7"
    assert "constraints" not in lock.get("manifest", {})
    assert all(
        package.get("wheels") for package in lock["package"] if "registry" in package["source"]
    )
    backend_dockerfile = read_repo_file("backend/Dockerfile")
    assert "uv sync --locked" in backend_dockerfile
    assert "--no-build" in backend_dockerfile
    assert "apt-get" not in backend_dockerfile
    assert "pip install --no-cache-dir ." not in backend_dockerfile
    assert "backend/uv.lock" in backend_dockerfile
    for filename in (".github/workflows/ci.yml", ".github/workflows/release-signoff.yml"):
        workflow = read_repo_file(filename)
        assert "uv sync --locked --extra dev --no-build" in workflow
        assert "npx --yes " + frontend["packageManager"] + " ci" in workflow
        assert 'node-version: "22.23.2"' in workflow


def test_ghcr_pair_promotion_rolls_back_both_images_when_second_update_fails(
    tmp_path: Path,
):
    promotion_script = REPO_ROOT / "scripts/promote-ghcr-pair.sh"
    fake_client = tmp_path / "fake-regctl"
    fake_client.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import os
            from pathlib import Path
            import sys

            args = sys.argv[1:]
            state = Path(os.environ["FAKE_REGISTRY_STATE"])
            target_tag = os.environ["FAKE_TARGET_TAG"]
            with (state / "commands.log").open("a", encoding="utf-8") as log:
                log.write(" ".join(args) + "\\n")

            if args and args[0] == "api":
                print(os.environ["TARGET_SHA"])
                raise SystemExit(0)

            def image_kind(ref: str) -> str:
                return "backend" if "/backend" in ref else "frontend"

            def target_path(ref: str) -> Path:
                return state / f"{image_kind(ref)}-{target_tag}.digest"

            if args[:2] == ["tag", "ls"]:
                ref = args[2]
                if target_path(ref).exists():
                    print(target_tag)
                raise SystemExit(0)

            if args[:2] == ["image", "digest"]:
                ref = args[2]
                if ":sha-" in ref:
                    raise SystemExit("Mutable candidate tag resolution is forbidden after smoke")
                if "@" in ref:
                    print(ref.rsplit("@", 1)[1])
                    raise SystemExit(0)
                path = target_path(ref)
                if not path.exists():
                    raise SystemExit(1)
                print(path.read_text(encoding="utf-8"))
                raise SystemExit(0)

            if args[:2] == ["image", "copy"]:
                source, target = args[2], args[3]
                digest = source.rsplit("@", 1)[1]
                if image_kind(target) == "frontend" and digest == "sha256:" + "c" * 64:
                    raise SystemExit(42)
                target_path(target).write_text(digest, encoding="utf-8")
                raise SystemExit(0)

            if args[:2] == ["tag", "delete"]:
                target_path(args[-1]).unlink(missing_ok=True)
                raise SystemExit(0)

            raise SystemExit(f"unexpected command: {args}")
            """
        ),
        encoding="utf-8",
    )
    fake_client.chmod(0o755)

    for case_name, old_digests in (
        ("first-promotion", None),
        ("existing-promotion", ("sha256:" + "d" * 64, "sha256:" + "e" * 64)),
    ):
        state = tmp_path / case_name
        state.mkdir()
        if old_digests:
            (state / "backend-edge.digest").write_text(old_digests[0], encoding="utf-8")
            (state / "frontend-edge.digest").write_text(old_digests[1], encoding="utf-8")

        env = os.environ.copy()
        env.update(
            {
                "BACKEND_IMAGE": "ghcr.io/acme/backend",
                "FRONTEND_IMAGE": "ghcr.io/acme/frontend",
                "BACKEND_DIGEST": "sha256:" + "b" * 64,
                "FRONTEND_DIGEST": "sha256:" + "c" * 64,
                "TARGET_SHA": "a" * 40,
                "CHANNEL": "edge",
                "VERSION_TAG": "",
                "GITHUB_REPOSITORY": "acme/swarmoracle",
                "REGCTL_BIN": str(fake_client),
                "GH_BIN": str(fake_client),
                "PROMOTE_MAX_ATTEMPTS": "1",
                "PROMOTE_RETRY_SLEEP_SECONDS": "0",
                "FAKE_REGISTRY_STATE": str(state),
                "FAKE_TARGET_TAG": "edge",
            }
        )
        result = subprocess.run(
            ["bash", str(promotion_script)],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )

        assert result.returncode != 0
        backend_state = state / "backend-edge.digest"
        frontend_state = state / "frontend-edge.digest"
        if old_digests is None:
            assert not backend_state.exists()
            assert not frontend_state.exists()
        else:
            assert backend_state.read_text(encoding="utf-8") == old_digests[0]
            assert frontend_state.read_text(encoding="utf-8") == old_digests[1]

        commands = (state / "commands.log").read_text(encoding="utf-8")
        assert ":sha-" not in commands
        assert "image copy ghcr.io/acme/backend@sha256:" + "b" * 64 in commands
        assert "image copy ghcr.io/acme/frontend@sha256:" + "c" * 64 in commands
        if old_digests is None:
            assert "tag delete --ignore-missing ghcr.io/acme/backend:edge" in commands
            assert "tag delete --ignore-missing ghcr.io/acme/frontend:edge" in commands
        else:
            assert "image copy ghcr.io/acme/backend@sha256:" + "d" * 64 in commands
            assert "image copy ghcr.io/acme/frontend@sha256:" + "e" * 64 in commands


def test_ci_executes_wave20_release_regressions_in_one_process_per_stack():
    workflow = read_repo_file(".github/workflows/ci.yml")
    release_signoff = read_repo_file("frontend/scripts/release-signoff.mjs")

    assert ".venv/bin/python -m pytest -q" in workflow
    assert ".venv/bin/ruff check app/ tests/" in workflow
    assert "run: npx --yes npm@11.12.1 test" in workflow
    assert "run: npx --yes npm@11.12.1 run lint" in workflow
    assert "npx --yes npm@11.12.1 exec -- tsc -b" in workflow
    assert "scripts/playwrightTeardown.test.mjs" in workflow

    assert 'const BACKEND_PYTEST_ARGS = ["-m", "pytest", "-q"]' in release_signoff
    assert 'const BACKEND_RUFF_ARGS = ["-m", "ruff", "check", "app/", "tests/"]' in release_signoff
    assert 'const FRONTEND_TEST_ARGS = ["test"]' in release_signoff
    assert '["tsc", "-b"]' in release_signoff


def test_release_scripts_do_not_force_success_exit():
    for script_path in (
        "frontend/scripts/e2e-suite.mjs",
        "frontend/scripts/e2e-debate-suite.mjs",
        "frontend/scripts/e2e-ending-room-followup-suite.mjs",
        "frontend/scripts/e2e-worldline-roundtable-suite.mjs",
    ):
        assert "process.exit(0)" not in read_repo_file(script_path), script_path


def test_docker_context_excludes_verified_local_only_directories():
    dockerignore = read_repo_file(".dockerignore")

    for relative_path in (
        ".ccg/cache",
        ".claude/session",
        ".release-audit/result.json",
        "frontend/.stitch/cache",
        "frontend/dist-spikes/index.html",
    ):
        assert dockerignore_ignores(dockerignore, relative_path), relative_path
