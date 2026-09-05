# Deploy Notes / 部署说明

## Host platforms / 宿主系统

Use Linux containers with Docker Desktop on Windows/macOS, or Docker Engine and
the Compose plugin on Linux. Native PowerShell and POSIX development commands are
in [README.en.md](../README.en.md#local-development) and
[README.md](../README.md#本地开发). Run `docker compose config --quiet` from the
repository root before deployment to check that your Compose version accepts the
configuration. Native Safari is an opt-in release test; a Linux WebKit result is
not a native Safari result.

Windows/macOS 使用 Docker Desktop 的 Linux 容器模式，Linux 使用 Docker Engine
与 Compose 插件。原生 PowerShell/POSIX 开发命令见上方中英文 README；部署前先在
仓库根目录运行 `docker compose config --quiet`。原生 Safari 签收仍需显式开启，
Linux WebKit 的结果不代表原生 Safari 已验证。

## Legacy data volume upgrade

旧版 Docker 数据卷升级：当前镜像以 UID 1000 运行。旧版 root 容器留下的数据卷
不会因拉取或重建镜像而改变所有者。只对需要升级的 Compose 项目执行下列一次性
维护流程；新建数据卷无需迁移。整个流程会暂停后端，并改变该项目 `/data` 数据卷
内的所有者，不修改宿主系统或其它卷的权限。

Current images run as UID 1000. Pulling or rebuilding an image does not change
ownership in a volume created by an older root-run container. Use this one-time
maintenance procedure only for the Compose project being upgraded. It stops the
backend and changes ownership within that project's `/data` volume. Fresh volumes
do not need migration. The application continues to run as a non-root user.

在原部署的仓库目录中，使用原来的 Compose 项目名和相同的 `-f` 参数。停止所有共享
该卷的其它写入进程后再执行。命令从现有 backend 容器的 `/data` 挂载读取真实卷名，
不会猜测目录前缀；未找到现有容器或命名卷时会停止。不要先运行 `down` 删除旧容器。

Run from the original deployment directory with the same Compose project name
and any original `-f` arguments. Stop any other writers sharing the volume first.
The commands obtain the actual volume name from the existing backend container's
`/data` mount and stop if the container or named volume is missing. Keep that
container until the backup is complete; do not run `down` first.

备份包含整个 `/data`，包括 SQLite 数据库、可能存在的 WAL/SHM 文件和 Chroma 数据。
流程先验证压缩归档可读取，再更改所有者；引号保留宿主路径中的空格。备份保存到
Git 已忽略的 `output/backups/`，包含私人推演和可能存储的凭据，应保留在自己的受限存储中。

The archive contains all of `/data`, including SQLite databases, any WAL/SHM
files, and Chroma data. Archive validation precedes ownership changes, and quoted
mount arguments preserve spaces in host paths. Backups go in the Git-ignored
`output/backups/` directory and contain private runs and possibly stored
credentials; keep them in storage you control.

### macOS / Linux

```bash
(
set -eu
SwarmBackendId=$(docker compose ps --all --quiet backend)
test -n "$SwarmBackendId"
SwarmVolume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$SwarmBackendId")
test -n "$SwarmVolume"
SwarmBackupImage=$(docker inspect --format '{{.Image}}' "$SwarmBackendId")
docker compose stop backend
mkdir -p "$(pwd)/output/backups"
SwarmBackupDir="$(pwd)/output/backups/backend-data-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$SwarmBackupDir"
docker run --rm --network none --user 0 --entrypoint tar \
  --mount "type=volume,src=$SwarmVolume,dst=/data,readonly" \
  --mount "type=bind,src=$SwarmBackupDir,dst=/backup" \
  "$SwarmBackupImage" -czf /backup/backend-data.tar.gz -C /data .
docker run --rm --network none --user 0 --entrypoint tar \
  --mount "type=bind,src=$SwarmBackupDir,dst=/backup,readonly" \
  "$SwarmBackupImage" -tzf /backup/backend-data.tar.gz > /dev/null
printf 'Verified backup: %s\n' "$SwarmBackupDir/backend-data.tar.gz"
docker run --rm --network none --user 0 --entrypoint chown \
  --mount "type=volume,src=$SwarmVolume,dst=/data" \
  "$SwarmBackupImage" -hR 1000:1000 /data
docker compose up -d --wait
docker compose exec -T backend python -c "import os, tempfile; assert os.getuid() == 1000; [tempfile.TemporaryFile(dir=p).close() for p in ('/data', '/data/chroma_data')]; print('Data directories writable as UID 1000')"
)
```

### Windows PowerShell

`Invoke-SwarmDocker` checks each native command's exit code, so a failed backup
cannot be hidden by a later successful command. / 此包装器检查每条 Docker 命令的退出码，
备份失败后不会继续更改权限。

```powershell
& {
    $ErrorActionPreference = 'Stop'
    function Invoke-SwarmDocker {
        & docker @args
        if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
    }
    $SwarmBackendId = Invoke-SwarmDocker compose ps --all --quiet backend
    if (@($SwarmBackendId).Count -ne 1 -or [string]::IsNullOrWhiteSpace($SwarmBackendId)) {
        throw 'Expected one existing backend container'
    }
    $SwarmContainer = (Invoke-SwarmDocker inspect $SwarmBackendId | ConvertFrom-Json)[0]
    $SwarmDataMounts = @($SwarmContainer.Mounts | Where-Object { $_.Destination -eq '/data' -and $_.Type -eq 'volume' })
    if ($SwarmDataMounts.Count -ne 1) { throw 'Expected one named /data volume' }
    $SwarmVolume = $SwarmDataMounts[0].Name
    if ([string]::IsNullOrWhiteSpace($SwarmVolume)) { throw 'Expected a named /data volume' }
    $SwarmBackupImage = $SwarmContainer.Image
    Invoke-SwarmDocker compose stop backend
    New-Item -ItemType Directory -Path output/backups -Force | Out-Null
    $SwarmBackupDir = Join-Path (Resolve-Path output/backups).Path ('backend-data-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
    New-Item -ItemType Directory -Path $SwarmBackupDir | Out-Null
    Invoke-SwarmDocker run --rm --network none --user 0 --entrypoint tar `
        --mount "type=volume,src=$SwarmVolume,dst=/data,readonly" `
        --mount "type=bind,src=$SwarmBackupDir,dst=/backup" `
        $SwarmBackupImage -czf /backup/backend-data.tar.gz -C /data .
    Invoke-SwarmDocker run --rm --network none --user 0 --entrypoint tar `
        --mount "type=bind,src=$SwarmBackupDir,dst=/backup,readonly" `
        $SwarmBackupImage -tzf /backup/backend-data.tar.gz | Out-Null
    Write-Output "Verified backup: $SwarmBackupDir/backend-data.tar.gz"
    Invoke-SwarmDocker run --rm --network none --user 0 --entrypoint chown `
        --mount "type=volume,src=$SwarmVolume,dst=/data" `
        $SwarmBackupImage -hR 1000:1000 /data
    Invoke-SwarmDocker compose up -d --wait
    Invoke-SwarmDocker compose exec -T backend python -c "import os, tempfile; assert os.getuid() == 1000; [tempfile.TemporaryFile(dir=p).close() for p in ('/data', '/data/chroma_data')]; print('Data directories writable as UID 1000')"
}
```

若任一步失败，保持后端停止并保留归档；排查后再继续。升级后检查服务健康、原有
推演和 Agent 资料是否可用。需要恢复时，先将归档恢复到单独的空卷，再让对应旧版
镜像使用该卷；不要覆盖仍在使用的数据卷，也不要用 `docker compose down -v` 回滚。

If a step fails, keep the backend stopped and retain the archive while diagnosing
the error. After startup, check health and existing runs and Agent records. For
recovery, restore the archive into a separate empty volume and attach it to the
matching previous image; do not overwrite an active volume or use
`docker compose down -v` as a rollback.

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
