# Deploy Notes / 部署说明

## Reproducible runtimes / 可复现依赖

`backend/uv.lock` is the single Python dependency resolution. Use uv **0.12.7** and
`uv sync --locked --extra dev --no-build` for development/CI. The Docker image uses
the same lock without the development extra. A missing wheel is an explicit
installation failure; no unpinned source-build dependencies are installed. The
lock includes platform markers for Windows and POSIX; it is not a macOS freeze.

后端只有一份 `uv.lock` 解析结果。开发/CI 与镜像共同使用它；不要把 `--locked`
换成绕过过期检查的 `--frozen`，也不要在启动时执行宽范围的 `pip install .`。
专用 uv 工具环境与应用环境分开，安装命令见中英文 README。升级依赖应单独评审，
重新解析并测试锁文件，不在部署时临时升级。

Docker bases are pinned by multi-platform manifest digest: Python **3.13.12**,
Node **22.23.2**, Nginx **1.27.5**, and builder uv **0.12.7**. npm **11.12.1** runs
through `npx --yes npm@11.12.1`; the host's global npm is unchanged. The pinned
Python base supplies the shared libraries required by the locked wheels, so the
build does not resolve floating apt packages.

## Configured verification matrix / 已配置的门禁

This table describes executable workflow coverage, not a claim that an unobserved
CI run or every OS release has passed. Runtime logs record the actual Python,
OS, and architecture. Read the run conclusions and uploaded evidence for the
exact commit before release.

| Surface | Configured gate | Evidence boundary |
| --- | --- | --- |
| Linux native | Ubuntu, Python 3.11 full backend suite; Python 3.13.12 portability smoke | Other distributions/versions are not implied |
| Windows native | `windows-latest`, Python 3.11, frontend scripts, offline backup/restore safety | Windows ARM64 is not validated |
| macOS native | `macos-latest`, Python 3.11, frontend scripts, offline backup/restore safety | Actual runner architecture is logged; no blanket Intel/ARM claim |
| Docker | Native `linux/amd64` and `linux/arm64` final-image jobs | Exact backend/frontend manifest digests, not native Vite preview |
| Frontend runtime | Node 22.23.2 / npm 11.12.1 in CI and image build | Declared Node compatibility is 20.19+ in 20.x or >=22.12 |
| Browser | Release signoff installs Chromium, Firefox, WebKit | Linux WebKit is not native Safari; build targets are not minimum-version test results |

Windows/macOS Docker usage requires Docker Desktop in Linux-container mode;
Linux requires Docker Engine and the Compose plugin. Run
`docker compose config --quiet` before using a deployment configuration. Compose
publishes frontend `18928` and backend `18927` on `127.0.0.1` by default.

## Final-image gate / 最终镜像验证

GHCR first builds SHA-tagged candidates. Each platform then pulls the **recorded
manifest digests** and executes `scripts/container_smoke.py` with a fresh internal
network and new data volumes. The gate checks shipped Nginx assets, official
sample import, snapshot export/import, the actual backend WebSocket heartbeat,
unbuffered report SSE, non-root data writes, restart readback, stopped-volume
backup, restore into a new volume, and readback from the restored application.
A Chroma collection uses supplied fixed embeddings, so no embedding model is
downloaded. The provider fixture is isolated and deliberately fails after a delay
to test the real SSE failure lifecycle. It does not establish model quality.

晋升作业等待 amd64、arm64 两个镜像作业通过，然后直接复制测试过的 digest。
它不会在测试后重新解析可能被后续构建移动的 SHA 标签。版本发布仍要求同一 SHA
的真实 release signoff；容器传输/恢复验证不能代替模型质量验证。

To reproduce with locally built image IDs or registry digests:

```bash
python3 scripts/container_smoke.py run \
  --backend-image 'sha256:BACKEND_IMAGE_ID_64_HEX' \
  --frontend-image 'sha256:FRONTEND_IMAGE_ID_64_HEX' \
  --platform linux/arm64 --output output/container-smoke-new-run
```

Replace the placeholders with actual IDs from `docker image inspect`. Registry
references must use `repository@sha256:...`. The output directory must be new or
empty. The JSON evidence records input digests, actual platform image IDs, checks,
and cleanup. The runner deletes only its labeled `swarm-impl-*` resources by ID;
it never invokes Docker prune or a user's Compose teardown.

## Offline backup and restore / 停机备份与恢复

Use `scripts/backup_restore.py` with Python 3.11+. Stop **all** processes or
containers that can write the selected data first. Native POSIX backup checks
open files with `lsof` and refuses to proceed if that check is unavailable;
Windows uses retained exclusive Win32 file handles. Docker volume backup refuses
any running container mounting the source volume. Source changes during copying
also fail the backup. SQLite is opened only in temporary restored copies, so
original WAL/SHM files and Chroma segments are copied without recovery writes.

`tar -tzf` only proves an archive is readable. This helper reports
`backup_and_restore_verified` only after extracting a real temporary restore and
checking file hashes, SQLite integrity, Alembic versions, table counts, and Chroma
collection/embedding markers. Missing Chroma markers are shown explicitly; verify
that all configured state directories were selected. Backups include private
runs and may contain credentials; keep them in restricted storage. Allow roughly
three times the data size in temporary free space for staging and validation.

### Native paths / 原生目录

For the default native layout, run from the repository root after stopping the
backend. `--include` avoids copying the virtual environment or source tree and
includes a selected database's `-wal` and `-shm` files automatically:

```bash
python3 scripts/backup_restore.py backup --source backend \
  --include swarmoracle.db --include chroma_data \
  --archive output/backups/native-20260905.tar.gz
python3 scripts/backup_restore.py verify --archive output/backups/native-20260905.tar.gz
python3 scripts/backup_restore.py restore --archive output/backups/native-20260905.tar.gz \
  --destination /absolute/path/to/NEW-swarmoracle-data
```

PowerShell uses the same helper without shell-specific archive commands:

```powershell
python scripts/backup_restore.py backup --source backend --include swarmoracle.db --include chroma_data --archive output/backups/native-20260905.tar.gz
if ($LASTEXITCODE -ne 0) { throw 'Backup or restore verification failed' }
python scripts/backup_restore.py restore --archive output/backups/native-20260905.tar.gz --destination 'C:\SwarmOracle-restore-new'
if ($LASTEXITCODE -ne 0) { throw 'Restore verification failed' }
```

Use the actual paths from `DATABASE_URL` and `CHROMA_PERSIST_DIR` if customized.
For a dedicated common data directory, `--source /path/to/data` copies the whole
directory. A selected component that does not exist is an error; a never-created
Chroma store may be omitted deliberately. Back up the actual environment file
separately if it is outside the data directory. After restore, point a stopped
instance at the **new** database and Chroma paths and inspect its existing runs
before cutover. Do not overwrite the original files. A failed extraction leaves
its new partial destination for inspection; retry into another new directory.

### Docker volumes / Docker 数据卷

Use the same Compose project name and `-f` arguments as the original deployment.
Keep the existing backend container until its image ID and `/data` volume are
identified. The helper needs the exact old backend image ID, which contains
Python; it does not pull a floating backup utility image.

macOS / Linux:

```bash
(
set -eu
SwarmBackendId=$(docker compose ps --all --quiet backend)
test -n "$SwarmBackendId"
SwarmVolume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$SwarmBackendId")
test -n "$SwarmVolume"
SwarmBackupImage=$(docker inspect --format '{{.Image}}' "$SwarmBackendId")
docker compose stop backend
SwarmArchive="$(pwd)/output/backups/backend-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
python3 scripts/backup_restore.py backup-volume --volume "$SwarmVolume" --image "$SwarmBackupImage" --archive "$SwarmArchive"
printf 'Restore-tested backup: %s\n' "$SwarmArchive"
)
```

PowerShell checks native exit codes explicitly:

```powershell
& {
  $ErrorActionPreference = 'Stop'
  function Invoke-SwarmDocker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker failed: $LASTEXITCODE" }
  }
  $SwarmBackendId = Invoke-SwarmDocker compose ps --all --quiet backend
  if (@($SwarmBackendId).Count -ne 1 -or [string]::IsNullOrWhiteSpace($SwarmBackendId)) { throw 'Expected one backend container' }
  $SwarmContainer = (Invoke-SwarmDocker inspect $SwarmBackendId | ConvertFrom-Json)[0]
  $SwarmMounts = @($SwarmContainer.Mounts | Where-Object { $_.Destination -eq '/data' -and $_.Type -eq 'volume' })
  if ($SwarmMounts.Count -ne 1) { throw 'Expected one named /data volume' }
  $SwarmVolume = $SwarmMounts[0].Name
  $SwarmBackupImage = $SwarmContainer.Image
  Invoke-SwarmDocker compose stop backend
  $SwarmArchive = Join-Path (Get-Location) ('output/backups/backend-data-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.tar.gz')
  python scripts/backup_restore.py backup-volume --volume $SwarmVolume --image $SwarmBackupImage --archive $SwarmArchive
  if ($LASTEXITCODE -ne 0) { throw 'Backup/restore verification failed; keep backend stopped' }
  Write-Output "Restore-tested backup: $SwarmArchive"
}
```

Restore to a new volume name on either shell:

```bash
python3 scripts/backup_restore.py restore-volume --archive /absolute/path/backup.tar.gz \
  --volume swarmoracle-restored-NEW --image 'sha256:EXACT_OLD_BACKEND_IMAGE_ID'
```

The destination volume must not already exist. Restored files become UID/GID
1000 for the current non-root runtime. Start the matching image against this
separate volume, verify health and historical runs, then update the deployment's
volume selection explicitly. The original volume remains intact. Never use
`docker compose down -v` as rollback. Older arbitrary tar archives lack this
helper's manifest; listing them is not restore verification and this helper
refuses them rather than guessing an extraction layout.

## Legacy data volume upgrade

Current backend images use UID 1000. Existing root-owned volumes retain their
ownership across image updates. For this maintenance operation use the complete
flow below: it identifies the original volume, stops the backend, creates and
restore-tests a new backup, and only then changes ownership. Fresh volumes need
no ownership repair. No original file contents are deleted.

macOS / Linux:

```bash
(
set -eu
SwarmBackendId=$(docker compose ps --all --quiet backend)
test -n "$SwarmBackendId"
SwarmVolume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$SwarmBackendId")
test -n "$SwarmVolume"
SwarmBackupImage=$(docker inspect --format '{{.Image}}' "$SwarmBackendId")
docker compose stop backend
SwarmArchive="$(pwd)/output/backups/legacy-upgrade-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
python3 scripts/backup_restore.py backup-volume --volume "$SwarmVolume" --image "$SwarmBackupImage" --archive "$SwarmArchive"
docker run --rm --network none --user 0 --entrypoint chown \
  --mount "type=volume,src=$SwarmVolume,dst=/data" \
  "$SwarmBackupImage" -hR 1000:1000 /data
docker compose up -d --wait
docker compose exec -T backend python -c "import os,tempfile; assert os.getuid()==1000; [tempfile.TemporaryFile(dir=p).close() for p in ('/data','/data/chroma_data')]; print('Data paths writable as UID 1000')"
)
```

PowerShell:

```powershell
& {
  $ErrorActionPreference = 'Stop'
  function Invoke-SwarmDocker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker failed: $LASTEXITCODE" }
  }
  $SwarmBackendId = Invoke-SwarmDocker compose ps --all --quiet backend
  if (@($SwarmBackendId).Count -ne 1 -or [string]::IsNullOrWhiteSpace($SwarmBackendId)) { throw 'Expected one backend container' }
  $SwarmContainer = (Invoke-SwarmDocker inspect $SwarmBackendId | ConvertFrom-Json)[0]
  $SwarmMounts = @($SwarmContainer.Mounts | Where-Object { $_.Destination -eq '/data' -and $_.Type -eq 'volume' })
  if ($SwarmMounts.Count -ne 1) { throw 'Expected one named /data volume' }
  $SwarmVolume = $SwarmMounts[0].Name
  $SwarmBackupImage = $SwarmContainer.Image
  Invoke-SwarmDocker compose stop backend
  $SwarmArchive = Join-Path (Get-Location) ('output/backups/legacy-upgrade-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.tar.gz')
  python scripts/backup_restore.py backup-volume --volume $SwarmVolume --image $SwarmBackupImage --archive $SwarmArchive
  if ($LASTEXITCODE -ne 0) { throw 'Backup/restore verification failed; keep backend stopped' }
  Invoke-SwarmDocker run --rm --network none --user 0 --entrypoint chown --mount "type=volume,src=$SwarmVolume,dst=/data" $SwarmBackupImage -hR 1000:1000 /data
  Invoke-SwarmDocker compose up -d --wait
  Invoke-SwarmDocker compose exec -T backend python -c "import os,tempfile; assert os.getuid()==1000; [tempfile.TemporaryFile(dir=p).close() for p in ('/data','/data/chroma_data')]; print('Data paths writable as UID 1000')"
}
```

If any step fails, keep the backend stopped and preserve the verified archive.
Inspect health and historical records after startup. Restore into a separate
volume with the matching old image if rollback is needed; do not overwrite the
original volume or use `docker compose down -v`.

Keep the **pre-upgrade backup and both exact old image digests together**.
Rollback to old application code requires that pre-upgrade backup unless backward
readability has been proved explicitly. A text enum change (for example a new
cancelled debate state) or a stricter report schema can break old readers even
without a database migration. The container recovery gate proves restoration
with the same tested image version; it does not certify that old images can read
data already written by a newer version.

## Docker Compose and Host LLM Endpoints on Native Linux

`host.docker.internal:host-gateway` provides **DNS/address mapping only**. On
native Linux, a host service listening solely on `127.0.0.1` is not reachable
through the Docker bridge gateway. Successful name resolution does not prove
that the endpoint accepts container connections.

For example, `LLM_RESPONSES_URL=http://host.docker.internal:8318/v1/chat/completions`
works only when the host gateway is actually reachable on that interface. Check
DNS and TCP reachability without sending a provider request:

```bash
docker compose exec -T backend python -c "import socket; print(socket.gethostbyname('host.docker.internal')); c=socket.create_connection(('host.docker.internal',8318),3); c.close(); print('TCP reachable; model/auth not tested')"
```

Docker Desktop supplies its own host-access mechanism. For native Linux, choose
an explicitly configured host gateway address/interface and appropriate access
controls, or keep a loopback-only LLM service together with a native backend.
Using the host's actual IP also requires a valid non-placeholder API key when the
endpoint is classified as non-local. Do not apply a standalone `network_mode: host`
override: it changes port publishing, binding behavior, and the frontend's
`backend` DNS relationship together. This guide does not change the host network
or open the gateway on every interface.
