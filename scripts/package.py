"""Package application source, excluding generated files and private runtime data."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from fnmatch import fnmatch
import hashlib
import os

root = Path(__file__).resolve().parents[1]
destination = root.parent / "Corner-Standalone.zip"
folders = ("apps", "packages", "scripts", "deployment")
names = (
    "package.json", "package-lock.json", "turbo.json", "tsconfig.json", "tsconfig.base.json",
    "README.md", "RELEASE-NOTES.md", "HOSTING.md", "LICENSE", "LICENSE.md", "NOTICE", "NOTICE.md",
    "Dockerfile", "compose.yaml", "compose.hosted.yaml", ".env.example", ".gitignore", ".dockerignore", ".nvmrc",
    ".github/workflows/ci.yml",
)
excluded_directories = {"node_modules", "dist", ".turbo", "__pycache__", "coverage", "data"}
# This checked-in catalog is application source; other data directories are
# private runtime storage and must remain outside the distributable archive.
catalog_data = root / "packages/shared/src/data"
excluded_files = (
    "*.sqlite*", "*.db", "*.db-*", "*.zip", "*.tgz", "*.tar", "*.tar.gz",
    "*.log", "*.pyc", "*.pyo", "*.tsbuildinfo", "*.pem", "*.key",
    "private-config.json", "credentials.json", "tokens.json", "secrets.json",
)


def source_file(path):
    relative = path.relative_to(root)
    return path.is_file() and not any(
        root.joinpath(*relative.parts[:index]).is_symlink()
        for index in range(1, len(relative.parts) + 1)
    )


paths = [root / name for name in names if source_file(root / name)]
for folder in folders:
    source = root / folder
    if not source.is_dir() or source.is_symlink():
        continue
    for directory, directories, files in os.walk(source, followlinks=False):
        # Prune generated trees before traversal, including dependencies nested
        # inside workspaces. Symlink targets must never escape the source tree.
        directories[:] = sorted(
            name for name in directories
            if (name not in excluded_directories or Path(directory) / name == catalog_data)
            and not name.startswith(".")
            and not (Path(directory) / name).is_symlink()
        )
        for name in files:
            path = Path(directory) / name
            if (name.startswith(".") and name != ".env.example") or any(fnmatch(name.lower(), pattern) for pattern in excluded_files):
                continue
            if path.is_file() and not path.is_symlink():
                paths.append(path)
with ZipFile(destination, "w", ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(set(paths)):
        archive.write(path, "corner/" + path.relative_to(root).as_posix())
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
print(f"Created {destination.name}: {destination.stat().st_size:,} bytes, {len(set(paths))} source files")
print(f"SHA-256: {digest}")
