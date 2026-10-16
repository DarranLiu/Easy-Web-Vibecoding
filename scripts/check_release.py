"""Check distributable files without printing potentially sensitive matches."""
import ipaddress
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
SECRETS = re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----)")
PRIVATE_PATHS = re.compile(rb"/(?:home|Users)/(?!your-user\b|runner\b|demo\b|example\b|user\b)[A-Za-z0-9_.-]+(?:/|(?=[\s\x22\x27]))")
IPV4 = re.compile(rb"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
EXAMPLE_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    '127.0.0.0/8', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24',
))


def distribution_paths():
    result = subprocess.run(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        cwd=ROOT, check=True, capture_output=True,
    )
    return [ROOT / name.decode() for name in result.stdout.split(b'\0') if name]


def check(paths):
    errors = []
    for path in paths:
        relative = path.relative_to(ROOT).as_posix()
        parts = path.relative_to(ROOT).parts
        if (any(part in {'.cc-web-images', 'backups', 'certs', '__pycache__', '.claude', '.codex', '.aws'} for part in parts)
                or (path.name.startswith('.env') and path.name != '.env.example')
                or path.suffix in {'.pem', '.key', '.crt', '.sqlite3', '.log', '.pyc'}):
            errors.append((relative, 'private runtime artifact'))
        if path.is_symlink():
            errors.append((relative, 'symlink is not a distributable asset'))
            continue
        data = path.read_bytes()
        for pattern, label in ((SECRETS, 'credential pattern'), (PRIVATE_PATHS, 'private deployment identifier')):
            if pattern.search(data):
                errors.append((relative, label))
        if path.suffix not in {'.py', '.js', '.cjs', '.mjs', '.css', '.html', '.md', '.json', '.yml', '.example', '.sh'}:
            continue
        for value in IPV4.findall(data):
            try:
                address = ipaddress.ip_address(value.decode())
            except ValueError:
                continue
            if address.is_private and not any(address in network for network in EXAMPLE_NETWORKS):
                # 0.0.0.0 is a documented listen address, not a private host.
                if str(address) != '0.0.0.0':
                    errors.append((relative, 'non-example private IP address'))
        if path.suffix == '.md':
            text = data.decode('utf-8')
            links = re.findall(r'\]\(([^\s)]+)', text) + re.findall(r'(?:src|href)="([^"]+)"', text)
            for link in links:
                parsed = urllib.parse.urlsplit(link)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                target = path.parent / urllib.parse.unquote(parsed.path)
                if not target.exists():
                    errors.append((relative, 'missing local documentation link'))
    return sorted(set(errors))


def main():
    paths = distribution_paths()
    errors = check(paths)
    for path, reason in errors:
        print(f'{path}: {reason}')
    print(f'Checked {len(paths)} distributable files; {len(errors)} findings.')
    return bool(errors)


if __name__ == '__main__':
    sys.exit(main())
