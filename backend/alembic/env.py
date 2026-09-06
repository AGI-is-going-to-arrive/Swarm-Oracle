"""Alembic environment configuration for SwarmOracle.

Reads the database URL from app.config.settings and uses SQLModel.metadata
for autogenerate support.
"""

from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, event, pool
from sqlmodel import SQLModel

# Import all models so SQLModel.metadata picks them up
import app.models  # noqa: F401
from alembic import context
from app.config import settings


def _enable_sqlite_fk_pragma(engine) -> None:
    """BE-1 follow-up: turn on FK enforcement for every sqlite connection used
    by the alembic migration runner. Applies to both the offline SQL-emit path
    (via leading `PRAGMA` statement) and the online `engine.connect()` path
    (via `event.listens_for("connect")`).
    """

    @event.listens_for(engine, "connect")
    def _set_fk_pragma(dbapi_conn, _connection_record):  # pragma: no cover - trivial
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

# Alembic Config object
config = context.config

# Alembic injects the INI directory as a raw ConfigParser default. Escape the
# literal path too, including when this environment is invoked by the CLI.
here = (
    Path(config.config_file_name).absolute().parent.as_posix() if config.config_file_name else "."
)
config.file_config.set("DEFAULT", "here", here.replace("%", "%%"))

# Override sqlalchemy.url with the app's configured database URL
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL.replace("%", "%%"))

# Set up Python logging from alembic.ini
if config.config_file_name is not None and config.attributes.get("configure_logging", True):
    fileConfig(config.config_file_name)

# Target metadata for autogenerate
target_metadata = SQLModel.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL without connecting)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,  # Required for SQLite ALTER TABLE
    )
    with context.begin_transaction():
        # BE-1 follow-up: emit a leading PRAGMA so the rendered SQL also
        # enforces FK integrity when applied by an external runner.
        if (url or "").startswith("sqlite"):
            context.execute("PRAGMA foreign_keys=ON")
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (connect to the DB)."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    # BE-1 follow-up: install the FK pragma listener on every sqlite
    # connection Alembic opens before the migration runs.
    if connectable.dialect.name == "sqlite":
        _enable_sqlite_fk_pragma(connectable)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # Required for SQLite ALTER TABLE
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
