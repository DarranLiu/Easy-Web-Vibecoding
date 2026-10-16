import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch

from scripts import check_release

ROOT = Path(__file__).resolve().parents[1]


class ReleaseContractTests(unittest.TestCase):
    def test_release_scan_rejects_credentials_without_echoing_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'example.md'
            value = 'ghp_' + 'x' * 36
            path.write_text(value)
            with patch.object(check_release, 'ROOT', root):
                findings = check_release.check([path])
            self.assertEqual(findings, [('example.md', 'credential pattern')])
            self.assertNotIn(value, str(findings))

    def test_release_scan_rejects_private_home_paths_with_or_without_a_slash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'example.md'
            for ending in ('/project', '"'):
                path.write_text('/home/' + 'private-person' + ending)
                with patch.object(check_release, 'ROOT', root):
                    self.assertIn(('example.md', 'private deployment identifier'), check_release.check([path]))

    def test_release_scan_allows_placeholder_paths_and_documentation_ips(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'example.md'
            path.write_text('/home/your-user/projects http://192.0.2.1 http://127.0.0.1')
            with patch.object(check_release, 'ROOT', root):
                self.assertEqual(check_release.check([path]), [])

    def test_service_restart_does_not_kill_detached_jobs(self):
        service = (ROOT / 'deploy/easy-web-vibecoding.service.example').read_text()
        self.assertIn('\nKillMode=process\n', service)
        self.assertIn('--no-access-log', service)

    def test_readmes_document_update_and_recovery_boundaries(self):
        for name, guide in (('README.md', 'UPDATES.en.md'), ('README.zh-CN.md', 'UPDATES.md')):
            text = (ROOT / name).read_text()
            self.assertIn(guide, text)
            self.assertIn('v0.2.0', text)
            self.assertIn('updates.png', text)
            self.assertIn('restart.png', text)
        english = (ROOT / 'docs/UPDATES.en.md').read_text()
        self.assertIn('does not upgrade code inside', (ROOT / 'README.md').read_text())
        self.assertIn('There is no built-in Git self-updater', english)
        self.assertIn('In-progress work may be interrupted', english)

    def test_all_new_bundled_assets_have_license_notices(self):
        notices = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text()
        for name in ('lucide-LICENSE.txt', 'Inter-LICENSE.txt', 'JetBrainsMono-LICENSE.txt',
                     'DejaVu-LICENSE.txt', 'XTERM-LICENSE.txt', 'frontend/assets/README.md'):
            self.assertIn(name, notices)
        for relative in ('frontend/vendor/lucide-LICENSE.txt', 'frontend/vendor/XTERM-LICENSE.txt',
                         'frontend/vendor/fonts/Inter-LICENSE.txt', 'frontend/vendor/fonts/JetBrainsMono-LICENSE.txt'):
            self.assertTrue((ROOT / relative).is_file(), relative)


if __name__ == '__main__':
    unittest.main()
